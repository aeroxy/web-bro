# Tool Loop

Web Bro implements a shallow tool loop that allows the agent to perform a limited set of operations on the workspace.

## Available Tools

The agent can use the following tools in a loop:
- `list_dir`: List contents of a directory
- `search_text`: Search for text within files
- `read_file`: Read the contents of a file
- `write_file`: Write content to a file (with undo snapshot)

## How It Works

1. The LLM worker receives a user query and decides which tool(s) to use.
2. It invokes the appropriate tool via the workspace worker.
3. The workspace worker performs the operation and returns the result.
4. The LLM worker processes the result and may decide to use another tool.
5. This continues until the LLM worker determines it has enough information to formulate a response.
6. The final response is generated and sent back to the user.

## Limitations

- The loop is "shallow" meaning there are limits on the number of iterations to prevent infinite loops.
- Each tool call is asynchronous and handled through worker messaging.
- The agent cannot execute arbitrary code or perform operations outside the defined tool set.

## Implementation

The tool loop is orchestrated in `src/app/store.ts` where actions are dispatched to invoke tools in the workspace worker.
Results are handled by updating the store and prompting the LLM worker for the next step or final response.