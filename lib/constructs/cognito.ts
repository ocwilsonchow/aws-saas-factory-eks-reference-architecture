/**
 * Cognito authentication construct for SaaS EKS Architecture
 *
 * This construct creates and configures a Cognito User Pool with appropriate settings
 * for authentication in a SaaS application. It handles:
 * - User pool creation with secure password policies
 * - Client app configuration with OAuth flows
 * - Custom attribute support
 * - Admin user creation
 * - Domain configuration for hosted UI
 */
import { Construct } from 'constructs';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito'

/**
 * Properties for configuring the Cognito construct
 */
export interface CognitoProps {
    /** Email address for the admin user that will be created */
    readonly adminUserEmailAddress: string;
    /** Name for the Cognito User Pool */
    readonly userPoolName: string;

    /** Optional custom attributes to add to the user pool */
    readonly customAttributes?: { [key: string]: { value: boolean | number | string, mutable: boolean } };
    /** Optional callback URL for authentication redirects */
    readonly callbackUrl?: string;
    /** Optional sign-out URL for post-logout redirects */
    readonly signoutUrl?: string;
    /** Optional subject line for invitation emails */
    readonly inviteEmailSubject?: string;
    /** Optional email body template for invitation emails */
    readonly inviteEmailBody?: string;
}

/**
 * Cognito authentication construct that creates and configures a user pool
 * with appropriate settings for SaaS applications
 */
export class Cognito extends Construct {
    /** ID of the app client created in the user pool */
    readonly appClientId: string;
    /** URL of the authentication server (user pool provider) */
    readonly authServerUrl: string;
    /** ID of the Cognito user pool */
    readonly userPoolId: string;

    constructor(scope: Construct, id: string, props: CognitoProps) {
        super(scope, id);

        // Configure callback and signout URLs if provided
        const callbackUrls = props.callbackUrl ? [props.callbackUrl!] : undefined;
        const signoutUrls = props.signoutUrl ? [props.signoutUrl!] : undefined;

        // Process custom attributes if provided
        let customAttributes: { [key: string]: cognito.ICustomAttribute } | undefined = undefined;
        if (props.customAttributes) {
            customAttributes = {};
            Object.keys(props.customAttributes!).forEach(key => {
                const item = props.customAttributes![key];
                switch (typeof (item.value)) {
                    case "boolean":
                        customAttributes![key] = new cognito.BooleanAttribute({ mutable: item.mutable });
                        break;
                    case "number":
                        customAttributes![key] = new cognito.NumberAttribute({ mutable: item.mutable });
                        break;
                    case "string":
                        customAttributes![key] = new cognito.StringAttribute({ mutable: item.mutable });
                        break;
                }
            });
        }

        // Create the Cognito User Pool with secure defaults
        const userPool = new cognito.UserPool(this, 'UserPool', {
            userPoolName: props.userPoolName,
            selfSignUpEnabled: false,
            userInvitation: {
                emailBody: props.inviteEmailBody,
                emailSubject: props.inviteEmailSubject
            },
            passwordPolicy: {
                minLength: 8,
                requireDigits: true,
                requireLowercase: true,
                requireUppercase: true,
                requireSymbols: false,
                tempPasswordValidity: Duration.days(7),
            },
            signInAliases: {
                email: true,
                username: false
            },
            autoVerify: {
                email: true
            },
            customAttributes: customAttributes,
            accountRecovery: cognito.AccountRecovery.NONE,
            mfa: cognito.Mfa.OFF,
            removalPolicy: RemovalPolicy.DESTROY
        });
        this.userPoolId = userPool.userPoolId;

        // Create a client app for the user pool
        const userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
            userPool: userPool,
            disableOAuth: false,
            oAuth: {
                flows: {
                    clientCredentials: false,
                    implicitCodeGrant: true,
                    authorizationCodeGrant: true
                },
                scopes: [
                    cognito.OAuthScope.PHONE,
                    cognito.OAuthScope.EMAIL,
                    cognito.OAuthScope.OPENID,
                    cognito.OAuthScope.PROFILE
                ],
                callbackUrls: callbackUrls,
                logoutUrls: signoutUrls,
            },
            generateSecret: false,
            authFlows: {
                adminUserPassword: true,
                custom: true,
                userPassword: true,
                userSrp: true,
            },
            preventUserExistenceErrors: true,
            refreshTokenValidity: Duration.days(30),
            supportedIdentityProviders: [
                cognito.UserPoolClientIdentityProvider.COGNITO
            ]
        });

        this.appClientId = userPoolClient.userPoolClientId;
        this.authServerUrl = userPool.userPoolProviderUrl;

        // Add a domain for the hosted UI
        userPool.addDomain(`${id}-Domain`, {
            cognitoDomain: {
                domainPrefix: this.appClientId
            }
        });

        // Create the admin user with appropriate attributes
        const userAttributes = [
            { name: "email", value: props.adminUserEmailAddress },
            { name: "email_verified", value: "true" }
        ];

        // Add any custom attributes to the admin user
        if (props.customAttributes) {
            Object.keys(props.customAttributes!).forEach(key => {
                userAttributes.push({ name: `custom:${key}`, value: props.customAttributes![key].value.toString() });
            })
        }

        // Create the admin user in the user pool
        const admin = new cognito.CfnUserPoolUser(this, 'AdminUser', {
            userPoolId: userPool.userPoolId,
            username: props.adminUserEmailAddress,
            userAttributes: userAttributes,
            desiredDeliveryMediums: [
                "EMAIL"
            ],
            forceAliasCreation: true
        });
    }
}
