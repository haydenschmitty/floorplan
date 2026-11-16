import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

const db = new DynamoDBClient({});

export const list = async () => ({ statusCode: 200, body: JSON.stringify(await db.send({})) });

export const create = async (event) => ({ statusCode: 201, body: event.body });

export const remove = async (event) => ({ statusCode: 204, body: event.pathParameters.id });

export const importAll = async (event) => ({ statusCode: 202, body: event.body });
