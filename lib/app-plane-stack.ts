/**
 * Application Plane Stack for SaaS EKS Architecture
 *
 * This stack creates the application plane components that handle tenant provisioning
 * and deprovisioning through event-driven architecture.
 *
 * Key components:
 * - Event Manager for handling tenant lifecycle events
 * - Provisioning Job Runner to handle tenant onboarding
 * - Deprovisioning Job Runner to handle tenant offboarding
 * - Core Application Plane that ties these components together
 */
import {
  CoreApplicationPlane,
  BashJobRunnerProps,
  DetailType,
  EventManager,
  BashJobRunner,
} from '@cdklabs/sbt-aws';
import { Stack, StackProps } from 'aws-cdk-lib';
import { EventBus } from 'aws-cdk-lib/aws-events';
import { Effect, PolicyDocument, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as fs from 'fs';

/**
 * Properties for the Application Plane Stack
 */
export interface AppPlaneStackProps extends StackProps {
  /** ARN of the event bus to use (optional - will create one if not provided) */
  readonly eventBusArn: string;
}

/**
 * Stack that implements the application plane for tenant lifecycle management
 */
export class AppPlaneStack extends Stack {
  constructor(scope: Construct, id: string, props: AppPlaneStackProps) {
    super(scope, id, props);

    // Set up event bus and event manager
    let eventBus;
    let eventManager;
    if (props?.eventBusArn) {
      // Use existing event bus if ARN is provided
      eventBus = EventBus.fromEventBusArn(this, 'EventBus', props.eventBusArn);
      eventManager = new EventManager(this, 'EventManager', {
        eventBus: eventBus,
      });
    } else {
      // Create new event bus if none provided
      eventManager = new EventManager(this, 'EventManager');
    }

    // Configure provisioning job runner properties
    const provisioningJobRunnerProps: BashJobRunnerProps = {
      eventManager,
      permissions: new PolicyDocument({
        statements: [
          new PolicyStatement({
            actions: ['*'],
            resources: ['*'],
            effect: Effect.ALLOW,
          }),
        ],
      }),
      script: fs.readFileSync('./scripts/provisioning.sh', 'utf8'),
      postScript: '',
      environmentStringVariablesFromIncomingEvent: [
        'tenantId',
        'tier',
        'tenantName',
        'email',
        'tenantStatus',
      ],
      environmentVariablesToOutgoingEvent: ['tenantConfig', 'tenantStatus'],
      outgoingEvent: DetailType.PROVISION_SUCCESS,
      incomingEvent: DetailType.ONBOARDING_REQUEST,
    };

    // Configure deprovisioning job runner properties
    const deprovisioningJobRunnerProps: BashJobRunnerProps = {
      eventManager,
      permissions: new PolicyDocument({
        statements: [
          new PolicyStatement({
            actions: ['*'],
            resources: ['*'],
            effect: Effect.ALLOW,
          }),
        ],
      }),
      script: fs.readFileSync('./scripts/deprovisioning.sh', 'utf8'),
      environmentStringVariablesFromIncomingEvent: ['tenantId', 'tier'],
      environmentVariablesToOutgoingEvent: ['tenantStatus'],
      outgoingEvent: DetailType.DEPROVISION_SUCCESS,
      incomingEvent: DetailType.OFFBOARDING_REQUEST,
    };

    // Create job runners for provisioning and deprovisioning
    const provisioningJobRunner: BashJobRunner = new BashJobRunner(
      this,
      'provisioningJobRunner',
      provisioningJobRunnerProps
    );
    const deprovisioningJobRunner: BashJobRunner = new BashJobRunner(
      this,
      'deprovisioningJobRunner',
      deprovisioningJobRunnerProps
    );

    // Create the core application plane with the job runners
    new CoreApplicationPlane(this, 'CoreApplicationPlane', {
      eventManager: eventManager,
      jobRunnersList: [provisioningJobRunner, deprovisioningJobRunner],
    });
  }
}
