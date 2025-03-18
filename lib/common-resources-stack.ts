/**
 * Common Resources Stack for SaaS EKS Architecture
 *
 * This stack creates and configures the shared resources used across the SaaS application:
 * - DynamoDB tables for tenant management and application data
 *
 * Key components:
 * - Tenant table for storing tenant information
 * - Product table using a pooled multi-tenant data model with tenant isolation
 */
import { RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

export interface CommonResourcesStackProps extends StackProps {
}

export class CommonResourcesStack extends Stack {
    constructor(scope: Construct, id: string, props: CommonResourcesStackProps) {
        super(scope, id, props);

        this.createPooledDynamoTables();
        this.createCommonDynamoTables();
    }

    /**
     * Creates DynamoDB tables for system-wide resources
     * These tables store data that is not specific to individual tenants
     */
    private createCommonDynamoTables(): void {
        const tenantTable = new dynamodb.Table(this, 'TenantTable', {
            tableName: "Tenant",
            partitionKey: {
                name: "TENANT_ID",
                type: dynamodb.AttributeType.STRING
            },
            readCapacity: 5,
            writeCapacity: 5,
            removalPolicy: RemovalPolicy.DESTROY
        });
    }

    /**
     * Creates DynamoDB tables that use a pooled multi-tenant data model
     * These tables use TenantId as part of the primary key to ensure tenant isolation
     */
    private createPooledDynamoTables(): void {
        new dynamodb.Table(this, 'ProductsTable', {
            tableName: "Product",
            partitionKey: {
                name: "TenantId",
                type: dynamodb.AttributeType.STRING
            },
            sortKey: {
                name: "ProductId",
                type: dynamodb.AttributeType.STRING
            },
            readCapacity: 5,
            writeCapacity: 5,
            removalPolicy: RemovalPolicy.DESTROY
        });
    }
}
