// IntrospectionSchemaProvider (http => IntrospectionResult => schema)
import { NotificationHandler } from "vscode-languageserver";
import { execute as linkExecute, toPromise } from "apollo-link";
import { createHttpLink, HttpLink } from "apollo-link-http";
import {
  GraphQLSchema,
  buildClientSchema,
  getIntrospectionQuery,
  ExecutionResult,
  IntrospectionQuery,
  parse
} from "graphql";
import { Agent as HTTPSAgent } from "https";
import { fetch } from "apollo-env";
import { RemoteServiceConfig } from "../../config";
import { GraphQLSchemaProvider, SchemaChangeUnsubscribeHandler } from "./base";
import { Debug } from "../../utilities";

export class EndpointSchemaProvider implements GraphQLSchemaProvider {
  private schema?: GraphQLSchema;
  private federatedServiceSDL?: string;

  constructor(private config: Omit<RemoteServiceConfig, "name">) {}
  async resolveSchema() {
    if (this.schema) return this.schema;
    const { skipSSLValidation, url, headers } = this.config;
    const options: HttpLink.Options = {
      uri: url,
      fetch
    };
    if (url.startsWith("https:") && skipSSLValidation) {
      options.fetchOptions = {
        agent: new HTTPSAgent({ rejectUnauthorized: false })
      };
    }

    const { data, errors } = (await toPromise(
      linkExecute(createHttpLink(options), {
        query: parse(getIntrospectionQuery()),
        context: { headers }
      })
    )) as ExecutionResult<IntrospectionQuery>;

    if (errors && errors.length) {
      // XXX better error handling of GraphQL errors
      throw new Error(errors.map(({ message }: Error) => message).join("\n"));
    }

    if (!data) {
      throw new Error("No data received from server introspection.");
    }

    this.schema = buildClientSchema(data);
    return this.schema;
  }

  onSchemaChange(
    _handler: NotificationHandler<GraphQLSchema>
  ): SchemaChangeUnsubscribeHandler {
    throw new Error("Polling of endpoint not implemented yet");
    return () => {};
  }

  async resolveFederatedServiceSDL() {
    if (this.federatedServiceSDL) return this.federatedServiceSDL;

    const { skipSSLValidation, url, headers } = this.config;
    const options: HttpLink.Options = {
      uri: url,
      fetch
    };
    if (url.startsWith("https:") && skipSSLValidation) {
      options.fetchOptions = {
        agent: new HTTPSAgent({ rejectUnauthorized: false })
      };
    }

    const getFederationInfoQuery = `
      query getFederationInfo {
        _service {
          sdl
        }
      }
    `;

    const { data, errors } = (await toPromise(
      linkExecute(createHttpLink(options), {
        query: parse(getFederationInfoQuery),
        context: { headers }
      })
    )) as ExecutionResult<{ _service: { sdl: string } }>;

    if (errors && errors.length) {
      return Debug.error(
        errors.map(({ message }: Error) => message).join("\n")
      );
    }

    if (!data || !data._service) {
      return Debug.error(
        "No data received from server when querying for _service."
      );
    }

    this.federatedServiceSDL = data._service.sdl;
    return data._service.sdl;
  }

  // public async isFederatedSchema() {
  //   const schema = this.schema || (await this.resolveSchema());
  //   return false;
  // }
}
