/**
 * Control Plane Stack for SaaS EKS Architecture
 *
 * This stack creates and configures the control plane for the SaaS application:
 * - Cognito authentication for user management
 * - Control plane API for tenant and system administration
 * - Event bus for system-wide event management
 *
 * Key components:
 * - Cognito User Pool for authentication
 * - API Gateway for control plane operations
 * - EventBridge for event management
 */
import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ControlPlane, CognitoAuth } from '@cdklabs/sbt-aws';

/**
 * Properties for configuring the Control Plane Stack
 */
export interface ControlPlaneStackProps extends StackProps {
  /** Email address for the system administrator */
  readonly systemAdminEmail: string;
}

/**
 * Stack that creates the control plane for the SaaS application
 */
export class ControlPlaneStack extends Stack {
  /** ARN of the event bus for system-wide events */
  eventBusArn: string;
  /** URL of the control plane API */
  controlPlaneUrl: string;
  /** Client ID for authentication */
  clientId: string;
  /** Authorization server URL */
  authorizationServer: string;
  /** Well-known endpoint URL for OIDC discovery */
  wellKnownEndpointUrl: string;

  constructor(scope: Construct, id: string, props: ControlPlaneStackProps) {
    super(scope, id, props);

    const idpName = 'COGNITO';
    const systemAdminRoleName = 'SystemAdmin';

    // Create Cognito authentication for the control plane
    const cognitoAuth = new CognitoAuth(this, 'CognitoAuth', {
      setAPIGWScopes: false, // only for testing purposes!
      controlPlaneCallbackURL: '',
    });

    // Create the control plane with the system admin and authentication
    const controlPlane = new ControlPlane(this, 'ControlPlane', {
      systemAdminEmail: props.systemAdminEmail,
      auth: cognitoAuth,
    });

    // Export important properties for use in other stacks
    this.controlPlaneUrl = controlPlane.controlPlaneAPIGatewayUrl;
    this.eventBusArn = controlPlane.eventManager.busArn;
    this.clientId = cognitoAuth.userClientId;
    this.wellKnownEndpointUrl = cognitoAuth.wellKnownEndpointUrl;
    const tokenEndpoint = cognitoAuth.tokenEndpoint;
    this.authorizationServer = tokenEndpoint.substring(0, tokenEndpoint.indexOf('/oauth2/token'));
  }
}
