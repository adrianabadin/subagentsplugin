export interface OpenCodeSessionClient {
  create?: (opts: {
    body: {
      parentID?: string;
      title?: string;
    };
  }) => Promise<unknown> | unknown;

  prompt?: (opts: {
    path: { id: string };
    body: {
      model?: {
        providerID: string;
        modelID: string;
      };
      agent?: string;
      parts: Array<{
        type: string;
        text: string;
      }>;
      noReply?: boolean;
    };
  }) => Promise<unknown> | unknown;

  promptAsync?: (opts: {
    path: { id: string };
    body: {
      model?: {
        providerID: string;
        modelID: string;
      };
      agent?: string;
      parts: Array<{
        type: string;
        text: string;
      }>;
      noReply?: boolean;
    };
  }) => Promise<unknown> | unknown;

  abort?: (opts: {
    path: { id: string };
    query?: {
      directory?: string;
    };
  }) => Promise<unknown> | unknown;

  children?: (opts: {
    path: { id: string };
    query?: {
      directory?: string;
    };
  }) => Promise<unknown> | unknown;
}

export interface OpenCodeClient {
  session?: OpenCodeSessionClient;
}
