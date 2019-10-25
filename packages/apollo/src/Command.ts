import Command, { flags } from "@oclif/command";
import Listr from "listr";
import { ListrTask } from "listr";
import { parse, resolve } from "path";

import {
  GraphQLServiceProject,
  GraphQLClientProject,
  loadConfig,
  ApolloConfig,
  getGraphIdFromKey,
  Debug,
  DefaultClientConfig,
  ClientConfig
} from "apollo-language-server";
import { WithRequired, DeepPartial } from "apollo-env";
import { OclifLoadingHandler } from "./OclifLoadingHandler";
import URI from "vscode-uri";
import { merge } from "lodash";

const { version, referenceID } = require("../package.json");

export interface ProjectContext<Flags = any, Args = any> {
  clientProject: GraphQLClientProject;
  serviceProject: GraphQLServiceProject;
  config: ApolloConfig;
  flags: Flags;
  args: Args;
}

export interface Flags {
  config?: string;
  header?: string[];
  endpoint?: string;
  localSchemaFile?: string;
  key?: string;
  engine?: string;
  frontend?: string;
  tag?: string;
  skipSSLValidation?: boolean;
}

export interface ClientCommandFlags extends Flags {
  includes?: string;
  queries?: string;
  excludes?: string;
  tagName?: string;
  clientName?: string;
  clientReferenceId?: string;
  clientVersion?: string;
}

const headersArrayToObject = (
  arr?: string[]
): Record<string, string> | undefined => {
  if (!arr) return;
  return arr
    .map(val => JSON.parse(val))
    .reduce((pre, next) => ({ ...pre, ...next }), {});
};

export abstract class ProjectCommand extends Command {
  static flags = {
    config: flags.string({
      char: "c",
      description: "Path to your Apollo config file"
    }),
    header: flags.string({
      multiple: true,
      parse: header => {
        const separatorIndex = header.indexOf(":");
        const key = header.substring(0, separatorIndex).trim();
        const value = header.substring(separatorIndex + 1).trim();
        return JSON.stringify({ [key]: value });
      },
      description:
        "Additional header to send to server for introspectionQuery. May be used multiple times to add multiple headers. NOTE: The `--endpoint` flag is REQUIRED if using the `--header` flag."
    }),
    endpoint: flags.string({
      description: "The url of your service"
    }),
    key: flags.string({
      description: "The API key for the Apollo Engine service",
      default: () => process.env.ENGINE_API_KEY
    }),
    engine: flags.string({
      description: "Reporting URL for a custom Apollo Engine deployment",
      hidden: true
    }),
    frontend: flags.string({
      description: "URL for a custom Apollo Engine frontend",
      hidden: true
    })
  };
  public serviceProject!: GraphQLServiceProject;
  public clientProject!: GraphQLClientProject;
  public tasks: ListrTask[] = [];

  protected type: "service" | "client" = "service";
  protected configMap?: (flags: any) => DeepPartial<ApolloConfig>;
  private ctx!: ProjectContext;

  async init() {
    const { flags, args } = this.parse(this.constructor as any);
    this.ctx = { flags, args } as any;

    // tell the language server to use the built-in loggers
    // from oclif
    Debug.SetLoggers({
      info: this.log,
      warning: this.warn,
      error: message => {
        this.error(message);
        this.exit(1);
      }
    });

    const config = await this.createConfig(flags);
    if (!config) return;

    this.createProject(config);
    this.ctx.config = config;

    // make sure this the first item in the task list
    // XXX Somehow this task gets pushed onto the stack multiple times sometimes
    this.tasks.push({
      title: "Loading Apollo Project",
      task: async ctx => {
        await Promise.all([
          this.clientProject.whenReady,
          this.serviceProject.whenReady
        ]);
        ctx = { ...ctx, ...this.ctx };
      }
    });
  }

  protected async createConfig(flags: Flags) {
    // loadConfig will also inject defaults into the config and ensure validity
    const config = await loadConfig({
      configPath: flags.config && parse(resolve(flags.config)).dir,
      configFileName: flags.config
    });

    if (!config) {
      this.error("A config failed to load, so the command couldn't be run");
      this.exit(1);
      return;
    }

    if (!config.service || !config.client || !config.engine) {
      this.error(
        "Failed to load configuration. You may need to upgrade your version of apollo-language-server"
      );
      this.exit(1);
      return;
    }

    config.serviceGraphVariant =
      flags.tag || config.serviceGraphVariant || "current";
    // Flags always override the config
    config.engine = merge(Object.create(null), config.engine, {
      apiKey: flags.key,
      endpoint: flags.engine,
      frontend: flags.frontend
    });

    if (flags.endpoint) {
      config.service.endpoint = merge(
        Object.create(null),
        config.service.endpoint,
        {
          url: flags.endpoint,
          headers: headersArrayToObject(flags.header),
          ...(flags.skipSSLValidation && { skipSSLValidation: true })
        }
      );
    }

    // this can set a single or multiple local schema files
    if (flags.localSchemaFile) {
      const files = flags.localSchemaFile.split(",");
      config.service.localSchemaFile = files;
      config.client.service = merge(
        Object.create(null),
        config.client.service,
        { localSchemaFile: files }
      );
    }

    // load per command type defaults;
    if (this.configMap) {
      const defaults = this.configMap(flags);
      config.setDefaults(defaults);
    }

    return config;
  }

  // The config passed in will always have client, service, and engine configuration by default
  protected createProject(config: ApolloConfig) {
    const loadingHandler = new OclifLoadingHandler(this);

    // When no config is provided, configURI === process.cwd()
    // In this case, we don't want to look to the .dir since that's the parent
    const configPath = config.configURI!.fsPath;
    const rootURI =
      configPath === process.cwd()
        ? URI.file(configPath)
        : URI.file(parse(configPath).dir);

    const clientIdentity = {
      name: "Apollo CLI",
      version,
      referenceID
    };

    if (!config.client || !config.service) {
      throw new Error("Client and service must be defined in config.");
    }
    this.clientProject = new GraphQLClientProject({
      config,
      loadingHandler,
      rootURI,
      clientIdentity
    });
    this.serviceProject = new GraphQLServiceProject({
      config,
      loadingHandler,
      rootURI,
      clientIdentity
    });

    this.ctx.serviceProject = this.serviceProject;
    this.ctx.clientProject = this.clientProject;
  }

  async runTasks<Result>(
    generateTasks: (context: ProjectContext) => ListrTask[],
    options?: Listr.ListrOptions | ((ctx: ProjectContext) => Listr.ListrOptions)
  ): Promise<Result> {
    const { ctx } = this;
    if (!ctx) {
      throw new Error("init must be called before trying to access this.ctx");
    }

    const tasks = await generateTasks(ctx);
    return new Listr([...this.tasks, ...tasks], {
      // Use the `verbose` renderer for tests. We need this for two reasons:
      // 1. We don't want to show a spinner in tests
      // 2. We want to see individual changes to titles and output lines; this is accomplished with the
      //    verbose renderer. Note that this _must_ be override-able because some functions require the
      //    `silent` renderer.
      ...(process.env.NODE_ENV === "test" && { renderer: "verbose" }),
      ...(options && typeof options === "function" ? options(ctx) : options),
      // @ts-ignore This option is added by https://github.com/SamVerschueren/listr-verbose-renderer#options
      dateFormat: false
    }).run();
  }
  async catch(err) {
    // handle any error from the command
    this.error(err);
  }
  async finally(err) {
    // called after run and catch regardless of whether or not the command errored
  }
}

export abstract class ClientCommand extends ProjectCommand {
  static flags = {
    ...ProjectCommand.flags,
    clientReferenceId: flags.string({
      description:
        "Reference id for the client which will match ids from client traces, will use clientName if not provided"
    }),
    clientName: flags.string({
      description: "Name of the client that the queries will be attached to"
    }),
    clientVersion: flags.string({
      description:
        "The version of the client that the queries will be attached to"
    }),
    tag: flags.string({
      char: "t",
      description: "The published service tag for this client"
    }),
    queries: flags.string({
      description: "Deprecated in favor of the includes flag"
    }),
    includes: flags.string({
      description:
        "Glob of files to search for GraphQL operations. This should be used to find queries *and* any client schema extensions"
    }),
    excludes: flags.string({
      description:
        "Glob of files to exclude for GraphQL operations. Caveat: this doesn't currently work in watch mode"
    }),
    tagName: flags.string({
      description:
        "Name of the template literal tag used to identify template literals containing GraphQL queries in Javascript/Typescript code"
    })
  };
  public project!: GraphQLClientProject;
  constructor(argv, config) {
    super(argv, config);
    this.type = "client";
    this.configMap = (flags: ClientCommandFlags) => {
      const config = {
        client: {
          name: flags.clientName,
          referenceID: flags.clientReferenceId,
          version: flags.clientVersion
        }
      } as WithRequired<DeepPartial<ApolloConfig>, "client">;
      if (flags.endpoint) {
        config.client.service = {
          url: flags.endpoint,
          headers: headersArrayToObject(flags.header)
        };
      }

      if (flags.includes || flags.queries) {
        config.client.includes = [flags.includes || flags.queries];
      }

      if (flags.excludes) {
        config.client.excludes = [flags.excludes];
      }

      if (flags.tagName) {
        config.client.tagName = flags.tagName;
      }

      return config;
    };
  }
}
