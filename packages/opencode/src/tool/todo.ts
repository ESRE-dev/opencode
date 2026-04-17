import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import DESCRIPTION_WRITE from "./todowrite.txt"
import DESCRIPTION_READ from "./todoread.txt"
import { Todo } from "../session/todo"

const parameters = z.object({
  todos: z.array(z.object(Todo.Info.shape)).describe("The updated todo list"),
})

type Metadata = {
  todos: Todo.Info[]
}

export const TodoWriteTool = Tool.define<typeof parameters, Metadata, Todo.Service>(
  "todowrite",
  Effect.gen(function* () {
    const todo = yield* Todo.Service

    return {
      description: DESCRIPTION_WRITE,
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "todowrite",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })

          yield* todo.update({
            sessionID: ctx.sessionID,
            todos: params.todos,
          })

          return {
            title: `${params.todos.filter((x) => x.status !== "completed").length} todos`,
            output: JSON.stringify(params.todos, null, 2),
            metadata: {
              todos: params.todos,
            },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof parameters, Metadata>
  }),
)

const empty = z.object({})

type ReadMetadata = {
  todos: Todo.Info[]
}

export const TodoReadTool = Tool.define<typeof empty, ReadMetadata, Todo.Service>(
  "todoread",
  Effect.gen(function* () {
    const todo = yield* Todo.Service

    return {
      description: DESCRIPTION_READ,
      parameters: empty,
      execute: (_params: z.infer<typeof empty>, ctx: Tool.Context<ReadMetadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "todoread",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })

          const todos = yield* todo.get(ctx.sessionID)
          return {
            title: `${todos.filter((x) => x.status !== "completed").length} todos`,
            metadata: {
              todos,
            },
            output: JSON.stringify(todos, null, 2),
          }
        }),
    } satisfies Tool.DefWithoutID<typeof empty, ReadMetadata>
  }),
)
