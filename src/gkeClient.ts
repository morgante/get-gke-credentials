/*
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { presence } from '@google-github-actions/actions-utils';
import { CredentialBody, ExternalAccountClientOptions, GoogleAuth } from 'google-auth-library';
import YAML from 'yaml';

// Do not listen to the linter - this can NOT be rewritten as an ES6 import statement.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version: appVersion } = require('../package.json');

// userAgent is the user agent string.
const userAgent = `google-github-actions:get-gke-credentials/${appVersion}`;

// clusterResourceNamePattern is the regular expression to use to match resource
// names.
const clusterResourceNamePattern = new RegExp(/^projects\/(.+)\/locations\/(.+)\/clusters\/(.+)$/i);

// membershipResourceNamePattern is the regular expression to use to match fleet membership
// name.
const membershipResourceNamePattern = new RegExp(
  /^projects\/(.+)\/locations\/(.+)\/memberships\/(.+)$/i,
);

/**
 * Available options to create the client.
 *
 * @param credentials GCP JSON credentials (default uses ADC).
 * @param endpoint GCP endpoint (useful for testing).
 */
type ClientOptions = {
  projectID?: string;
  location?: string;
  credentials?: CredentialBody | ExternalAccountClientOptions;
};

/**
 * Wraps interactions with the Google Cloud Cluster API.
 *
 * @param location Location of the GCP resource.
 * @param opts list of ClientOptions.
 * @returns Cluster client.
 */
export class ClusterClient {
  /**
   * parseResourceName parses a string as a cluster resource name. If it's just
   * a cluster name, it returns an empty project ID and location. If a full
   * resource name is given, the values are parsed and returned. All other
   * inputs throw an error.
   *
   * @param name Name of the cluster (e.g. "my-cluster" or "projects/p/locations/l/clusters/c")
   */
  static parseResourceName(name: string): {
    projectID: string;
    location: string;
    id: string;
  } {
    name = (name || '').trim();
    if (!name) {
      throw new Error(`Failed to parse cluster name: value is the empty string`);
    }

    if (!name.includes('/')) {
      return {
        projectID: '',
        location: '',
        id: name,
      };
    }

    const matches = name.match(clusterResourceNamePattern);
    if (!matches) {
      throw new Error(`Failed to parse cluster name "${name}": invalid pattern`);
    }

    return {
      projectID: matches[1],
      location: matches[2],
      id: matches[3],
    };
  }

  /**
   * parseMembershipName parses a string as a Fleet membership name. A full
   * resource name is expected and the values are parsed and returned. All other
   * inputs throw an error.
   *
   * @param name Name of the fleet membership "projects/p/locations/l/memberships/m"
   */
  static parseMembershipName(name: string): {
    projectID: string;
    location: string;
    membershipName: string;
  } {
    name = (name || '').trim();
    if (!name) {
      throw new Error(`Failed to parse membership name: membership name cannot be empty`);
    }

    const matches = name.match(membershipResourceNamePattern);
    if (!matches) {
      throw new Error(
        `Failed to parse membership name "${name}": invalid pattern. Should be of form projects/PROJECT_ID/locations/LOCATION/memberships/MEMBERSHIP_NAME`,
      );
    }
    return {
      projectID: matches[1],
      location: matches[2],
      membershipName: matches[3],
    };
  }

  /**
   * projectID and location are hints to the client if a resource name does not
   * include the full resource name. If a full resource name is given (e.g.
   * `projects/p/locations/l/clusters/c`), then that is used. However, if just a
   * name is given (e.g. `c`), these values will be used to construct the full
   * resource name.
   */
  readonly #projectID?: string;
  readonly #location?: string;

  readonly defaultEndpoint = 'https://container.googleapis.com/v1';
  readonly hubEndpoint = 'https://gkehub.googleapis.com/v1';
  readonly cloudResourceManagerEndpoint = 'https://cloudresourcemanager.googleapis.com/v3';
  readonly connectGatewayHostPath = 'connectgateway.googleapis.com/v1';
  readonly auth: GoogleAuth;

  constructor(opts: ClientOptions) {
    this.auth = new GoogleAuth({
      scopes: [
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/userinfo.email',
      ],
      credentials: opts?.credentials,
      projectId: opts?.projectID,
    });

    this.#projectID = opts?.projectID;
    this.#location = opts?.location;
  }

  /**
   * Retrieves the auth client for authenticating requests.
   *
   * @returns string
   */
  async getToken(): Promise<string> {
    const token = await this.auth.getAccessToken();
    if (!token) {
      throw new Error('Failed to generate token.');
    }
    return token;
  }

  /**
   * Generates full resource name.
   *
   * @param name cluster name.
   * @returns full resource name.
   */
  getResource(name: string): string {
    name = (name || '').trim();
    if (!name) {
      throw new Error(`Failed to parse cluster name: name cannot be empty`);
    }

    if (name.includes('/')) {
      if (name.match(clusterResourceNamePattern)) {
        return name;
      } else {
        throw new Error(`Invalid cluster name "${name}"`);
      }
    }

    const projectID = this.#projectID;
    if (!projectID) {
      throw new Error(`Failed to get project ID to build cluster name. Try setting "project_id".`);
    }

    const location = this.#location;
    if (!location) {
      throw new Error(
        `Failed to get location (region/zone) to build cluster name. Try setting "location".`,
      );
    }

    return `projects/${projectID}/locations/${location}/clusters/${name}`;
  }

  /**
   * Converts a project ID to project number.
   *
   * @param projectID project ID.
   * @returns project number.
   */
  async projectIDtoNum(projectID: string): Promise<string> {
    const url = `${this.cloudResourceManagerEndpoint}/projects/${projectID}`;
    const resp = (await this.auth.request({
      url: url,
      headers: {
        'User-Agent': userAgent,
      },
    })) as { data: { name: string } };

    // projectRef of form projects/<project-num>"
    const projectRef = resp.data?.name;
    const projectNum = projectRef.replace('projects/', '');
    if (!projectRef.includes('projects/') || !projectNum) {
      throw new Error(
        `Failed to parse project number: expected format projects/PROJECT_NUMBER. Got ${projectRef}`,
      );
    }
    return projectNum;
  }

  /**
   * Constructs a Connect Gateway endpoint string of form
   * connectGatewayEndpoint/v1/projects/123/locations/l/memberships/m
   *
   * @param membershipName membership name.
   * @returns endpoint.
   */
  async getConnectGWEndpoint(membershipName: string): Promise<string> {
    const membershipRef = ClusterClient.parseMembershipName(membershipName);
    const projectNum = await this.projectIDtoNum(membershipRef.projectID);
    return `${this.connectGatewayHostPath}/projects/${projectNum}/locations/${membershipRef.location}/memberships/${membershipRef.membershipName}`;
  }

  /**
   * Retrieves a Cluster.
   *
   * @param fqn Cluster name
   * @returns a Cluster object.
   */
  async getCluster(clusterName: string): Promise<ClusterResponse> {
    const url = `${this.defaultEndpoint}/${this.getResource(clusterName)}`;
    const resp = (await this.auth.request({
      url: url,
      headers: {
        'User-Agent': userAgent,
      },
    })) as ClusterResponse;
    return resp;
  }

  /**
   * discoverClusterMembership attempts to discover
   * Fleet membership of a cluster.
   *
   * @param clusterName cluster name.
   * @returns Fleet membership name.
   */
  async discoverClusterMembership(clusterName: string): Promise<string> {
    const clusterResourceLink = `//container.googleapis.com/${this.getResource(clusterName)}`;
    const projectID = this.#projectID;
    if (!projectID) {
      throw new Error(
        `Failed to get project ID for cluster membership discovery. Try setting "project_id".`,
      );
    }
    const url = `${this.hubEndpoint}/projects/${projectID}/locations/global/memberships?filter=endpoint.gkeCluster.resourceLink="${clusterResourceLink}"`;
    const resp = (await this.auth.request({
      url: url,
      headers: {
        'User-Agent': userAgent,
      },
    })) as HubMembershipsListResponse;

    const memberships = resp.data.resources;
    if (memberships.length < 1) {
      throw new Error(
        `Expected one membership for ${clusterName} in ${projectID}. ` +
          `Found none. Verify membership by running \`gcloud container fleet memberships list --project ${projectID}\``,
      );
    }
    if (memberships.length > 1) {
      const membershipNames = memberships.map((m) => m.name).join(',');
      throw new Error(
        `Expected one membership for ${clusterName} in ${projectID}. ` +
          `Found multiple memberships ${membershipNames}. Provide an explicit membership via \`fleet_membership\` input.`,
      );
    }
    return memberships[0].name;
  }

  /**
   * Create kubeconfig for cluster.
   *
   * @param opts Input options. See CreateKubeConfigOptions.
   */
  async createKubeConfig(opts: CreateKubeConfigOptions): Promise<string> {
    const cluster = opts.clusterData;
    let endpoint = cluster.data.endpoint;
    const connectGatewayEndpoint = presence(opts.connectGWEndpoint);
    if (connectGatewayEndpoint) {
      endpoint = connectGatewayEndpoint;
    }
    if (opts.useInternalIP) {
      endpoint = cluster.data.privateClusterConfig.privateEndpoint;
    }

    const auth = opts.useAuthProvider
      ? { user: { 'auth-provider': { name: 'gcp' } } }
      : { user: { token: await this.getToken() } };
    const contextName = opts.contextName;

    const kubeConfig: KubeConfig = {
      'apiVersion': 'v1',
      'clusters': [
        {
          cluster: {
            ...(!connectGatewayEndpoint && {
              'certificate-authority-data': cluster.data.masterAuth?.clusterCaCertificate,
            }),
            server: `https://${endpoint}`,
          },
          name: cluster.data.name,
        },
      ],
      'contexts': [
        {
          context: {
            cluster: cluster.data.name,
            user: cluster.data.name,
          },
          name: contextName,
        },
      ],
      'kind': 'Config',
      'current-context': contextName,
      'users': [{ ...{ name: cluster.data.name }, ...auth }],
    };
    return YAML.stringify(kubeConfig);
  }
}

type cluster = {
  cluster: {
    'certificate-authority-data'?: string;
    'server': string;
  };
  name: string;
};

type context = {
  context: {
    cluster: string;
    user: string;
  };
  name: string;
};

export type CreateKubeConfigOptions = {
  // useAuthProvider is a boolean to use short lived OIDC token or GCP auth
  // plugin in kubectl.
  useAuthProvider: boolean;

  // useInternalIP is a boolean to use the internal IP address of the cluster
  // endpoint.
  useInternalIP: boolean;

  // clusterData is the cluster response data.
  clusterData: ClusterResponse;

  // connectGWEndpoint is the optional Connect Gateway endpoint.
  connectGWEndpoint?: string;

  // contextName is the name of the context.
  contextName: string;
};

export type KubeConfig = {
  'apiVersion': string;
  'clusters': cluster[];
  'contexts': context[];
  'current-context': string;
  'kind': string;
  'users': [
    {
      name: string;
      user: {
        'token'?: string;
        'auth-provider'?: { name: string };
      };
    },
  ];
};

export type ClusterResponse = {
  data: {
    name: string;
    endpoint: string;
    masterAuth: {
      clusterCaCertificate: string;
    };
    privateClusterConfig: {
      privateEndpoint: string;
    };
  };
};

/**
 * HubMembershipsListResponse is the response from listing GKE Hub memberships.
 */
type HubMembershipsListResponse = {
  data: {
    resources: [
      {
        name: string;
        endpoint: {
          gkeCluster: {
            resourceLink: string;
          };
        };
      },
    ];
  };
};
