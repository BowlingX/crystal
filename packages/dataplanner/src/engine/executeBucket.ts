import { inspect } from "util";

import type { Bucket, RequestContext } from "../bucket.js";
import type { CrystalError } from "../error.js";
import { newCrystalError } from "../error.js";
import type { ExecutableStep } from "../index.js";
import { __ListTransformStep } from "../index.js";
import type {
  CrystalValuesList,
  ExecutionExtra,
  PromiseOrDirect,
} from "../interfaces.js";
import { arrayOfLength, isPromiseLike } from "../utils.js";

/**
 * Calls the callback, catching any errors and turning them into rejected
 * promises.
 *
 * @remarks
 *
 * When we're calling functions in loops and they may or may not be async
 * functions, there's a risk that they may throw and previous promises that may
 * have been added to an array to be handled later never get handled, causing
 * an unhandled promise rejection error which crashes the entire Node process.
 * This is not ideal. Thus we use this method to try to call the function, but
 * if it throws we turn it into a promise rejection which will not interrupt
 * the flow of these loops.
 */
function rejectOnThrow<T>(cb: () => T): T | Promise<never> {
  try {
    return cb();
  } catch (e) {
    return Promise.reject(e);
  }
}

/**
 * Takes a list of `results` (shorter than `resultCount`) and an object with
 * errors and indexes; returns a list of length `resultCount` with the results
 * from `results` but with errors injected at the indexes specified in
 * `errors`.
 *
 * ASSERT: `results.length + Object.values(errors).length === resultCount`
 *
 * @internal
 */
function mergeErrorsBackIn(
  results: ReadonlyArray<any>,
  errors: { [index: number]: CrystalError },
  resultCount: number,
): any[] {
  const finalResults: any[] = [];
  let resultIndex = 0;

  for (let i = 0; i < resultCount; i++) {
    const error = errors[i];
    if (error) {
      finalResults[i] = error;
    } else {
      finalResults[i] = results[resultIndex++];
    }
  }
  return finalResults;
}

/** @internal */
export function executeBucket(
  bucket: Bucket,
  requestContext: RequestContext,
): PromiseOrDirect<void> {
  const { metaByStepId } = requestContext;
  const inProgressSteps = new Set();
  const pendingSteps = new Set(bucket.layerPlan.steps);
  const {
    size,
    store,
    noDepsList,
    layerPlan: { startSteps, children: childLayerPlans },
  } = bucket;

  const starterPromises: PromiseLike<void>[] = [];
  for (const step of startSteps) {
    const r = rejectOnThrow(() => executeStep(step));
    if (isPromiseLike(r)) {
      starterPromises.push(r);
    }
  }

  if (starterPromises.length > 0) {
    return Promise.all(starterPromises).then(executeSamePhaseChildren);
  } else {
    return executeSamePhaseChildren();
  }

  // Function definitions below here

  function reallyCompletedStep(
    finishedStep: ExecutableStep,
  ): void | Promise<void> {
    inProgressSteps.delete(finishedStep);
    pendingSteps.delete(finishedStep);
    if (pendingSteps.size === 0) {
      // Finished!
      return;
    }
    const promises: PromiseLike<void>[] = [];
    for (const potentialNextStep of finishedStep.dependentPlans) {
      const isPending = pendingSteps.has(potentialNextStep);
      const isSuitable = isPending
        ? potentialNextStep.dependencies.every((depId) =>
            Array.isArray(store[depId]),
          )
        : false;
      if (isSuitable) {
        const r = rejectOnThrow(() => executeStep(potentialNextStep));
        if (isPromiseLike(r)) {
          promises.push(r);
        }
      }
    }
    if (promises.length > 0) {
      return Promise.all(promises) as Promise<any> as Promise<void>;
    } else {
      return;
    }
  }

  function completedStep(
    finishedStep: ExecutableStep,
    result: CrystalValuesList<any>,
    noNewErrors = false,
  ): void | Promise<void> {
    if (!Array.isArray(result)) {
      throw new Error(
        `Result from ${finishedStep} should be an array, instead received ${inspect(
          result,
          { colors: true },
        )}`,
      );
    }
    if (result.length !== size) {
      throw new Error(
        `Result array from ${finishedStep} should have length ${size}, instead it had length ${result.length}`,
      );
    }
    if (finishedStep.isSyncAndSafe && noNewErrors) {
      // It promises not to add new errors, and not to include promises in the result array
      store[finishedStep.id] = result;
      return reallyCompletedStep(finishedStep);
    } else {
      // Need to complete promises, check for errors, etc
      return Promise.allSettled(result).then((rs) => {
        // Deliberate shadowing
        const result = rs.map((t) => {
          if (t.status === "fulfilled") {
            return t.value;
          } else {
            bucket.hasErrors = true;
            return newCrystalError(t.reason, finishedStep.id);
          }
        });
        store[finishedStep.id] = result;
        return reallyCompletedStep(finishedStep);
      });
    }
  }

  // Slow mode...
  /**
   * Execute the step, filtering out errors from the input dependencies and
   * then padding the lists back out at the end.
   */
  function reallyExecuteStepWithErrors(
    step: ExecutableStep,
    dependencies: ReadonlyArray<any>[],
    extra: ExecutionExtra,
  ) {
    const errors: { [index: number]: CrystalError } = Object.create(null);
    let foundErrors = false;
    for (const depList of dependencies) {
      for (let index = 0, l = depList.length; index < l; index++) {
        const v = depList[index];
        if (isCrystalError(v)) {
          if (!errors[index]) {
            foundErrors = true;
            errors[index] = v;
          }
        }
      }
    }
    if (foundErrors) {
      const dependenciesWithoutErrors = dependencies.map((depList) =>
        depList.filter((_, index) => !errors[index]),
      );
      const resultWithoutErrors = step.execute(
        dependenciesWithoutErrors,
        extra,
      );
      if (isPromiseLike(resultWithoutErrors)) {
        return resultWithoutErrors.then((r) =>
          mergeErrorsBackIn(r, errors, dependencies[0].length),
        );
      } else {
        return mergeErrorsBackIn(
          resultWithoutErrors,
          errors,
          dependencies[0].length,
        );
      }
    } else {
      return reallyExecuteStepWithNoErrors(step, dependencies, extra);
    }
  }

  // TODO: if this is what we end up with, remove the indirection.
  /**
   * Execute the step directly; since there's no errors we can pass the
   * dependencies through verbatim!
   */
  function reallyExecuteStepWithNoErrors(
    step: ExecutableStep,
    dependencies: ReadonlyArray<any>[],
    extra: ExecutionExtra,
  ) {
    return step.execute(dependencies, extra);
  }

  // TODO: this function used to state that it would never throw/reject... but,
  // no code is perfect... so that just seemed like it was asking for
  // trouble. Lets make sure if it throws/rejects that nothing bad will happen.
  /**
   * This function MIGHT throw or reject, so be sure to handle that.
   */
  function executeStep(step: ExecutableStep): void | PromiseLike<void> {
    if (inProgressSteps.has(step)) {
      return;
    }
    inProgressSteps.add(step);
    try {
      const meta = metaByStepId[step.id]!;
      const extra = {
        meta,
        eventEmitter: requestContext.eventEmitter,
      };
      const dependencies: ReadonlyArray<any>[] = [];
      const depCount = step.dependencies.length;
      if (depCount > 0) {
        for (let i = 0, l = depCount; i < l; i++) {
          const depId = step.dependencies[i];
          dependencies[i] = store[depId];
        }
      } else {
        dependencies.push(noDepsList);
      }
      const result = bucket.hasErrors
        ? reallyExecuteStepWithErrors(step, dependencies, extra)
        : reallyExecuteStepWithNoErrors(step, dependencies, extra);
      if (isPromiseLike(result)) {
        return result.then(
          (values) => {
            return completedStep(step, values);
          },
          (error) => {
            bucket.hasErrors = true;
            return completedStep(
              step,
              arrayOfLength(size, newCrystalError(error, step.id)),
            );
          },
        );
      } else {
        return completedStep(step, result, true);
      }
    } catch (error) {
      bucket.hasErrors = true;
      return completedStep(
        step,
        arrayOfLength(size, newCrystalError(error, step.id)),
        true,
      );
    }
  }

  function executeSamePhaseChildren(): PromiseOrDirect<void> {
    if (pendingSteps.size > 0) {
      throw new Error(
        `executeSamePhaseChildren called before all steps were complete! Remaining steps were: ${[
          ...pendingSteps,
        ].join(", ")}`,
      );
    }

    // TODO: create a JIT factory for this at planning time
    const childPromises: PromiseLike<any>[] = [];
    for (const childLayerPlan of childLayerPlans) {
      switch (childLayerPlan.reason.type) {
        case "listItem": {
          // processListChildren?
          throw new Error("TODO");
        }
        case "mutationField": {
          // BE SURE TO SERIALIZE!
          throw new Error("TODO");

          /*
          const childBucket: Bucket = {
            isComplete: false,
            size: 0,
            layerPlan: childLayerPlan,
            store: Object.create(null),
            hasErrors: bucket.hasErrors,
            layerPlan: child.layerPlan,
            store: child.store,
            noDepsList: arrayOfLength(child.input.length),
            hasErrors: bucket.hasErrors,
          };
          for (const planId of childLayerPlan.copyPlanIds) {
            entry.store[planId] = [];
          }
          if (childLayerPlan.reason.type === "listItem") {
            entry.store[childLayerPlan.rootStepId!] = [];
          }
          const r = rejectOnThrow(() =>
            executeBucket(childBucket, requestContext),
          );
          if (isPromiseLike(r)) {
            childPromises.push(r);
          }
          */
        }
        case "polymorphic": {
          throw new Error("TODO");
        }
        case "subroutine":
        case "subscription":
        case "defer":
        case "stream": {
          // Ignore; these are handled elsewhere
          continue;
        }
        case "root": {
          throw new Error(
            "GraphileInternalError<05fb7069-81b5-43f7-ae71-f62547d2c2b7>: root cannot be not the root (...)",
          );
        }
        default: {
          const never: never = childLayerPlan.reason;
          throw new Error(
            `GraphileInternalError<>: unhandled reason '${inspect(never)}'`,
          );
        }
      }
    }

    if (childPromises.length > 0) {
      return Promise.all(childPromises).then(() => {});
    } else {
      return;
    }

    // Function definitions below here

    bucket.isComplete = true;
  }
}
