/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DatabaseAccountGetResults } from '@azure/arm-cosmosdb/src/models';
import { MongoClient } from 'mongodb';
import * as vscode from 'vscode';
import { appendExtensionUserAgent, AzureParentTreeItem, AzureTreeItem, ICreateChildImplContext, parseError } from 'vscode-azureextensionui';
import { deleteCosmosDBAccount } from '../../commands/deleteCosmosDBAccount';
import { getThemeAgnosticIconPath, Links, testDb } from '../../constants';
import { ext } from '../../extensionVariables';
import { nonNullProp } from '../../utils/nonNull';
import { connectToMongoClient } from '../connectToMongoClient';
import { getDatabaseNameFromConnectionString } from '../mongoConnectionStrings';
import { IMongoTreeRoot } from './IMongoTreeRoot';
import { MongoCollectionTreeItem } from './MongoCollectionTreeItem';
import { MongoDatabaseTreeItem } from './MongoDatabaseTreeItem';
import { MongoDocumentTreeItem } from './MongoDocumentTreeItem';

export class MongoAccountTreeItem extends AzureParentTreeItem<IMongoTreeRoot> {
    public static contextValue: string = "cosmosDBMongoServer";
    public readonly contextValue: string = MongoAccountTreeItem.contextValue;
    public readonly childTypeLabel: string = "Database";
    public readonly id: string;
    public readonly label: string;
    public readonly connectionString: string;

    private _root: IMongoTreeRoot;

    constructor(parent: AzureParentTreeItem, id: string, label: string, connectionString: string, isEmulator: boolean | undefined, readonly databaseAccount?: DatabaseAccountGetResults) {
        super(parent);
        this.id = id;
        this.label = label;
        this.connectionString = connectionString;
        this._root = Object.assign({}, parent.root, { isEmulator });
    }

    // overrides ISubscriptionContext with an object that also has Mongo info
    public get root(): IMongoTreeRoot {
        return this._root;
    }

    public get iconPath(): string | vscode.Uri | { light: string | vscode.Uri; dark: string | vscode.Uri } {
        return getThemeAgnosticIconPath('CosmosDBAccount.svg');
    }

    public hasMoreChildrenImpl(): boolean {
        return false;
    }

    public async loadMoreChildrenImpl(_clearCache: boolean): Promise<AzureTreeItem<IMongoTreeRoot>[]> {
        let mongoClient: MongoClient | undefined;
        try {
            let databases: IDatabaseInfo[];

            if (!this.connectionString) {
                throw new Error('Missing connection string');
            }

            // Azure MongoDB accounts need to have the name passed in for private endpoints
            mongoClient = await connectToMongoClient(this.connectionString, this.databaseAccount ? nonNullProp(this.databaseAccount, 'name') : appendExtensionUserAgent());

            const databaseInConnectionString = getDatabaseNameFromConnectionString(this.connectionString);
            if (databaseInConnectionString && !this.root.isEmulator) { // emulator violates the connection string format
                // If the database is in the connection string, that's all we connect to (we might not even have permissions to list databases)
                databases = [{
                    name: databaseInConnectionString,
                    empty: false
                }];
            } else {
                // https://mongodb.github.io/node-mongodb-native/3.1/api/index.html
                const result: { databases: IDatabaseInfo[] } = await mongoClient.db(testDb).admin().listDatabases();
                databases = result.databases;
            }
            return databases
                .filter((database: IDatabaseInfo) => !(database.name && database.name.toLowerCase() === "admin" && database.empty)) // Filter out the 'admin' database if it's empty
                .map(database => new MongoDatabaseTreeItem(this, nonNullProp(database, 'name'), this.connectionString));
        } catch (error) {
            const message = parseError(error).message;
            if (this._root.isEmulator && message.includes("ECONNREFUSED")) {
                error.message = `Unable to reach emulator. See ${Links.LocalConnectionDebuggingTips} for debugging tips.\n${message}`;
            }
            throw error;
        }
        finally {
            if (mongoClient) {
                // grandfathered in
                // tslint:disable-next-line: no-floating-promises
                mongoClient.close();
            }
        }
    }

    public async createChildImpl(context: ICreateChildImplContext): Promise<MongoDatabaseTreeItem> {
        const databaseName = await ext.ui.showInputBox({
            placeHolder: "Database Name",
            prompt: "Enter the name of the database",
            validateInput: validateDatabaseName
        });
        context.showCreatingTreeItem(databaseName);

        return new MongoDatabaseTreeItem(this, databaseName, this.connectionString);
    }

    public isAncestorOfImpl(contextValue: string): boolean {
        switch (contextValue) {
            case MongoDatabaseTreeItem.contextValue:
            case MongoCollectionTreeItem.contextValue:
            case MongoDocumentTreeItem.contextValue:
                return true;
            default:
                return false;
        }
    }

    public async deleteTreeItemImpl(): Promise<void> {
        await deleteCosmosDBAccount(this);
    }
}

function validateDatabaseName(database: string): string | undefined | null {
    // https://docs.mongodb.com/manual/reference/limits/#naming-restrictions
    // "#?" are restricted characters for CosmosDB - MongoDB accounts
    const min = 1;
    const max = 63;
    if (!database || database.length < min || database.length > max) {
        return `Database name must be between ${min} and ${max} characters.`;
    }
    if (/[/\\. "$#?]/.test(database)) {
        return "Database name cannot contain these characters - `/\\. \"$#?`";
    }
    return undefined;
}

export interface IDatabaseInfo {
    name?: string;
    empty?: boolean;
}
