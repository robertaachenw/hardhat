import debug from "debug";

import {
  Artifacts as IArtifacts,
  EnvironmentExtender,
  ExperimentalHardhatNetworkMessageTraceHook,
  HardhatArguments,
  HardhatConfig,
  HardhatRuntimeEnvironment,
  HardhatUserConfig,
  Network,
  ParamDefinition,
  RunSuperFunction,
  RunTaskFunction,
  SubtaskArguments,
  TaskArguments,
  TaskDefinition,
  TasksMap,
} from "../../types";
import { Artifacts } from "../artifacts";
import { MessageTrace } from "../hardhat-network/stack-traces/message-trace";
import { lazyObject } from "../util/lazy";

import { getHardhatVersion } from "../util/packageInfo";
import { analyzeModuleNotFoundError } from "./config/config-loading";
import { HardhatError } from "./errors";
import { ERRORS } from "./errors-list";
import { createProvider } from "./providers/construction";
import { OverriddenTaskDefinition } from "./tasks/task-definitions";
import {
  completeTaskProfile,
  createParentTaskProfile,
  createTaskProfile,
  TaskProfile,
} from "./task-profiling";

const log = debug("hardhat:core:hre");

export class Environment implements HardhatRuntimeEnvironment {
  private static readonly _BLACKLISTED_PROPERTIES: string[] = [
    "injectToGlobal",
    "entryTaskProfile",
    "_runTaskDefinition",
    "_extenders",
  ];

  public network: Network;

  public artifacts: IArtifacts;

  private readonly _extenders: EnvironmentExtender[];

  public entryTaskProfile?: TaskProfile;

  public version: string = getHardhatVersion();

  /**
   * Initializes the Hardhat Runtime Environment and the given
   * extender functions.
   *
   * @remarks The extenders' execution order is given by the order
   * of the requires in the hardhat's config file and its plugins.
   *
   * @param config The hardhat's config object.
   * @param hardhatArguments The parsed hardhat's arguments.
   * @param tasks A map of tasks.
   * @param extenders A list of extenders.
   */
  constructor(
    public readonly config: HardhatConfig,
    public readonly hardhatArguments: HardhatArguments,
    public readonly tasks: TasksMap,
    extenders: EnvironmentExtender[] = [],
    experimentalHardhatNetworkMessageTraceHooks: ExperimentalHardhatNetworkMessageTraceHook[] = [],
    public readonly userConfig: HardhatUserConfig = {}
  ) {
    log("Creating HardhatRuntimeEnvironment");

    const networkName =
      hardhatArguments.network !== undefined
        ? hardhatArguments.network
        : config.defaultNetwork;

    const networkConfig = config.networks[networkName];

    if (networkConfig === undefined) {
      throw new HardhatError(ERRORS.NETWORK.CONFIG_NOT_FOUND, {
        network: networkName,
      });
    }

    this.artifacts = new Artifacts(config.paths.artifacts);

    const provider = lazyObject(() => {
      log(`Creating provider for network ${networkName}`);
      return createProvider(
        networkName,
        networkConfig,
        this.config.paths,
        this.artifacts,
        experimentalHardhatNetworkMessageTraceHooks.map(
          (hook) => (trace: MessageTrace, isCallMessageTrace: boolean) =>
            hook(this, trace, isCallMessageTrace)
        )
      );
    });

    this.network = {
      name: networkName,
      config: config.networks[networkName],
      provider,
    };

    this._extenders = extenders;

    extenders.forEach((extender) => extender(this));
  }

  /**
   * Executes the task with the given name.
   *
   * @param name The task's name.
   * @param taskArguments A map of task's arguments.
   * @param subtaskArguments A map of subtasks to their arguments.
   *
   * @throws a HH303 if there aren't any defined tasks with the given name.
   * @returns a promise with the task's execution result.
   */
  public readonly run: RunTaskFunction = async (
    name,
    taskArguments = {},
    subtaskArguments = {},
    callerTaskProfile?: TaskProfile
  ) => {
    const taskDefinition = this.tasks[name];

    log("Running task %s", name);

    if (taskDefinition === undefined) {
      throw new HardhatError(ERRORS.ARGUMENTS.UNRECOGNIZED_TASK, {
        task: name,
      });
    }

    const resolvedTaskArguments = this._resolveValidTaskArguments(
      taskDefinition,
      taskArguments,
      subtaskArguments
    );

    let taskProfile: TaskProfile | undefined;
    if (this.hardhatArguments.flamegraph === true) {
      taskProfile = createTaskProfile(name);

      if (callerTaskProfile !== undefined) {
        callerTaskProfile.children.push(taskProfile);
      } else {
        this.entryTaskProfile = taskProfile;
      }
    }

    try {
      return await this._runTaskDefinition(
        taskDefinition,
        resolvedTaskArguments,
        subtaskArguments,
        taskProfile
      );
    } catch (e) {
      analyzeModuleNotFoundError(e, this.config.paths.configFile);

      // eslint-disable-next-line @nomiclabs/hardhat-internal-rules/only-hardhat-error
      throw e;
    } finally {
      if (taskProfile !== undefined) {
        completeTaskProfile(taskProfile);
      }
    }
  };

  /**
   * Injects the properties of `this` (the Hardhat Runtime Environment) into the global scope.
   *
   * @param blacklist a list of property names that won't be injected.
   *
   * @returns a function that restores the previous environment.
   */
  public injectToGlobal(
    blacklist: string[] = Environment._BLACKLISTED_PROPERTIES
  ): () => void {
    const globalAsAny = global as any;

    const previousValues: { [name: string]: any } = {};
    const previousHre = globalAsAny.hre;

    globalAsAny.hre = this;

    for (const [key, value] of Object.entries(this)) {
      if (blacklist.includes(key)) {
        continue;
      }

      previousValues[key] = globalAsAny[key];
      globalAsAny[key] = value;
    }

    return () => {
      for (const [key, _] of Object.entries(this)) {
        if (blacklist.includes(key)) {
          continue;
        }

        globalAsAny.hre = previousHre;
        globalAsAny[key] = previousValues[key];
      }
    };
  }

  /**
   * @param taskProfile Undefined if we aren't computing task profiles
   * @private
   */
  private async _runTaskDefinition(
    taskDefinition: TaskDefinition,
    taskArguments: TaskArguments,
    subtaskArguments: SubtaskArguments,
    taskProfile?: TaskProfile
  ): Promise<any> {
    let runSuperFunction: any;

    if (taskDefinition instanceof OverriddenTaskDefinition) {
      runSuperFunction = async (
        _taskArguments: TaskArguments = taskArguments,
        _subtaskArguments: SubtaskArguments = subtaskArguments
      ) => {
        log("Running %s's super", taskDefinition.name);

        if (taskProfile === undefined) {
          return this._runTaskDefinition(
            taskDefinition.parentTaskDefinition,
            _taskArguments,
            _subtaskArguments
          );
        }

        const parentTaskProfile = createParentTaskProfile(taskProfile);
        taskProfile.children.push(parentTaskProfile);

        try {
          return await this._runTaskDefinition(
            taskDefinition.parentTaskDefinition,
            _taskArguments,
            _subtaskArguments,
            parentTaskProfile
          );
        } finally {
          completeTaskProfile(parentTaskProfile);
        }
      };

      runSuperFunction.isDefined = true;
    } else {
      runSuperFunction = async () => {
        throw new HardhatError(ERRORS.TASK_DEFINITIONS.RUNSUPER_NOT_AVAILABLE, {
          taskName: taskDefinition.name,
        });
      };

      runSuperFunction.isDefined = false;
    }

    const runSuper: RunSuperFunction<TaskArguments> = runSuperFunction;

    const globalAsAny = global as any;
    const previousRunSuper: any = globalAsAny.runSuper;
    globalAsAny.runSuper = runSuper;

    // We create a modified version of `this`, as we want to keep track of the
    // `subtaskArguments` and `taskProfile` through `run` invocations. This
    // way we keep track of callers's data, even when tasks are run in parallel.
    //
    // Note that for this to work we need to set the prototype later
    let modifiedHre: any = {
      ...this,
      run: (
        _name: string,
        _taskArguments: TaskArguments,
        _subtaskArguments: SubtaskArguments
      ) =>
        (this as any).run(
          _name,
          _taskArguments,
          { ..._subtaskArguments, ...subtaskArguments }, // parent subtask args take precedence
          taskProfile
        ),
    };

    if (this.hardhatArguments.flamegraph === true) {
      // We modify the `this` again to add  a few utility methods.
      modifiedHre = {
        ...modifiedHre,
        adhocProfile: async (_name: string, f: () => Promise<any>) => {
          const adhocProfile = createTaskProfile(_name);
          taskProfile!.children.push(adhocProfile);
          try {
            return await f();
          } finally {
            completeTaskProfile(adhocProfile);
          }
        },
        adhocProfileSync: (_name: string, f: () => any) => {
          const adhocProfile = createTaskProfile(_name);
          taskProfile!.children.push(adhocProfile);
          try {
            return f();
          } finally {
            completeTaskProfile(adhocProfile);
          }
        },
      };
    }

    Object.setPrototypeOf(modifiedHre, Object.getPrototypeOf(this));

    const uninjectFromGlobal =
      modifiedHre?.injectToGlobal() ?? this.injectToGlobal();

    try {
      return await taskDefinition.action(
        taskArguments,
        modifiedHre ?? this,
        runSuper
      );
    } finally {
      uninjectFromGlobal();
      globalAsAny.runSuper = previousRunSuper;
    }
  }

  /**
   * Check that task arguments are within TaskDefinition defined params constraints.
   * Also, populate missing, non-mandatory arguments with default param values (if any).
   *
   * @private
   * @throws HardhatError if any of the following are true:
   *  > a required argument is missing
   *  > an argument's value's type doesn't match the defined param type
   *
   * @param taskDefinition
   * @param taskArguments
   * @returns resolvedTaskArguments
   */
  private _resolveValidTaskArguments(
    taskDefinition: TaskDefinition,
    taskArguments: TaskArguments,
    subtaskArguments: SubtaskArguments
  ): TaskArguments {
    const {
      name: taskName,
      paramDefinitions,
      positionalParamDefinitions,
    } = taskDefinition;

    const nonPositionalParamDefinitions = Object.values(paramDefinitions);

    // gather all task param definitions
    const allTaskParamDefinitions = [
      ...nonPositionalParamDefinitions,
      ...positionalParamDefinitions,
    ];

    const resolvedArguments: TaskArguments = {};

    for (const paramDefinition of allTaskParamDefinitions) {
      const paramName = paramDefinition.name;
      const argumentValue =
        subtaskArguments[taskName]?.[paramName] ?? taskArguments[paramName];

      const resolvedArgumentValue = this._resolveArgument(
        paramDefinition,
        argumentValue,
        taskDefinition.name
      );

      if (resolvedArgumentValue !== undefined) {
        resolvedArguments[paramName] = resolvedArgumentValue;
      }
    }

    // We keep the args in taskArguments that were not resolved
    return { ...taskArguments, ...resolvedArguments };
  }

  /**
   * Resolves an argument according to a ParamDefinition rules.
   *
   * @param paramDefinition
   * @param argumentValue
   * @private
   */
  private _resolveArgument(
    paramDefinition: ParamDefinition<any>,
    argumentValue: any,
    taskName: string
  ) {
    const { name, isOptional, defaultValue } = paramDefinition;

    if (argumentValue === undefined) {
      if (isOptional) {
        // undefined & optional argument -> return defaultValue
        return defaultValue;
      }

      // undefined & mandatory argument -> error
      throw new HardhatError(ERRORS.ARGUMENTS.MISSING_TASK_ARGUMENT, {
        param: name,
        task: taskName,
      });
    }

    // arg was present -> validate type, if applicable
    this._checkTypeValidation(paramDefinition, argumentValue);

    return argumentValue;
  }

  /**
   * Checks if value is valid for the specified param definition.
   *
   * @param paramDefinition {ParamDefinition} - the param definition for validation
   * @param argumentValue - the value to be validated
   * @private
   * @throws HH301 if value is not valid for the param type
   */
  private _checkTypeValidation(
    paramDefinition: ParamDefinition<any>,
    argumentValue: any
  ) {
    const { name: paramName, type, isVariadic } = paramDefinition;

    // in case of variadic param, argValue is an array and the type validation must pass for all values.
    // otherwise, it's a single value that is to be validated
    const argumentValueContainer = isVariadic ? argumentValue : [argumentValue];

    for (const value of argumentValueContainer) {
      type.validate(paramName, value);
    }
  }
}
