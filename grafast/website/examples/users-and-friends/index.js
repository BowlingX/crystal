const {
  buildSchema,
  // printSchema,
  graphql,
  execute: graphqlExecute,
  parse,
  validate,
} = require("graphql");
const {
  makeGrafastSchema,
  context,
  each,
  grafast,
  stringifyPayload,
  execute: grafastExecute,
} = require("grafast");
const { makeDataLoaders } = require("./dataloaders");
const { userById, friendshipsByUserId } = require("./plans");
const fsp = require("node:fs/promises");

const typeDefs = /* GraphQL */ `
  type Query {
    currentUser: User
  }
  type User {
    name: String!
    friends: [User]!
  }
`;
const resolvers = {
  Query: {
    async currentUser(_, args, context) {
      return context.userLoader.load(context.currentUserId);
    },
  },
  User: {
    name(user) {
      return user.full_name;
    },
    async friends(user, args, context) {
      const friendships = await context.friendshipsByUserIdLoader.load(user.id);
      const friends = await Promise.all(
        friendships.map((friendship) =>
          context.userLoader.load(friendship.friend_id),
        ),
      );
      return friends;
    },
  },
};

const planResolvers = {
  Query: {
    currentUser() {
      return userById(context().get("currentUserId"));
    },
  },
  User: {
    name($user) {
      return $user.get("full_name");
    },
    friends($user) {
      const $friendships = friendshipsByUserId($user.get("id"));
      const $friends = each($friendships, ($friendship) =>
        userById($friendship.get("friend_id")),
      );
      return $friends;
    },
  },
};

const makeGraphQLSchema = () => {
  const schema = buildSchema(typeDefs);
  // Mutating a schema after it's generated is a Bad Idea. Don't do this in your own code.
  for (const [typeName, fieldResolvers] of Object.entries(resolvers)) {
    const type = schema.getType(typeName);
    const fields = type.getFields();
    for (const [fieldName, resolver] of Object.entries(fieldResolvers)) {
      const field = fields[fieldName];
      field.resolve = resolver;
    }
  }
  return schema;
};

const graphqlSchema = makeGraphQLSchema();
const grafastSchema = makeGrafastSchema({
  typeDefs,
  plans: planResolvers,
  enableDeferStream: false,
});
// console.log(printSchema(graphqlSchema));
// console.log(printSchema(grafastSchema));

const source = /* GraphQL */ `
  {
    currentUser {
      name
      friends {
        name
        friends {
          name
        }
      }
    }
  }
`;

// To make it fair, we parse and validate the query ahead of time and just time
// execution (because grafast caches parse results).

const document = parse(source);
const errors1 = validate(graphqlSchema, document);
const errors2 = validate(grafastSchema, document);
if (errors1.length) {
  throw errors1[0];
}
if (errors2.length) {
  throw errors2[0];
}

async function runGraphQL() {
  const result = await graphqlExecute({
    schema: graphqlSchema,
    document,
    contextValue: {
      ...baseContext,
      ...makeDataLoaders(),
    },
  });
  return JSON.stringify(result);
}

const asString = false;
const baseContext = { currentUserId: 1 };
async function runGraphastWithGraphQLSchema() {
  const result = await grafastExecute(
    {
      schema: graphqlSchema,
      document,
      contextValue: { ...baseContext, ...makeDataLoaders() },
    },
    { asString },
  );
  return stringifyPayload(result, asString);
}

async function runGraphast() {
  const result = await grafastExecute(
    {
      schema: grafastSchema,
      document,
      contextValue: baseContext,
    },
    { asString },
  );
  return stringifyPayload(result, asString);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function benchmark(callback) {
  // Warmup
  for (let i = 0; i < 500; i++) {
    await callback();
  }
  await sleep(5000);

  // Setup
  const NUMBER_OF_REQUESTS = 10000;
  const CONCURRENCY = 2;
  let result;
  function run() {
    function pass(res) {
      result = res;
      return runner();
    }
    function fail(e) {
      console.error(e);
      process.exit(1);
    }
    let remaining = NUMBER_OF_REQUESTS;
    async function runner() {
      if (remaining > 0) {
        --remaining;
        return callback().then(pass, fail);
      }
    }
    const promises = [];
    for (let i = 0; i < CONCURRENCY; i++) {
      promises.push(runner());
    }
    return Promise.all(promises);
  }

  // Benchmark
  const start = process.hrtime.bigint();
  await run();
  const stop = process.hrtime.bigint();

  // Output
  console.log(result);
  console.log(
    `Served ${NUMBER_OF_REQUESTS} requests, each producing the above. Took ${
      (stop - start) / 1000000n
    }ms`,
  );

  return result;
}

async function runCompare() {
  console.log("GRAPHQL");
  const graphqlResult = await graphql({
    schema: graphqlSchema,
    source,
    contextValue: {
      ...baseContext,
      ...makeDataLoaders(),
    },
  });
  console.dir(graphqlResult, { depth: Infinity });

  console.log("GRAFAST");
  const grafastResult = await grafast({
    schema: grafastSchema,
    source,
    contextValue: baseContext,
  });
  console.dir(grafastResult, { depth: Infinity });

  console.log(
    "Same?",
    JSON.stringify(graphqlResult) === JSON.stringify(grafastResult),
  );

  console.log("GRAFAST AGAIN");
  const grafastResultWithPlan = await grafast(
    {
      schema: grafastSchema,
      source,
      contextValue: baseContext,
    },
    { explain: ["mermaid-js"] },
  );
  await fsp.writeFile(
    `${__dirname}/plan.mermaid`,
    grafastResultWithPlan.extensions.explain.operations[0].diagram,
  );
}

async function main() {
  switch (process.argv[2]) {
    case "graphql":
      return benchmark(runGraphQL);
    case "grafast":
      return benchmark(runGraphast);
    case "grafast-resolvers":
      return benchmark(runGraphastWithGraphQLSchema);
    default: {
      return runCompare();
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
