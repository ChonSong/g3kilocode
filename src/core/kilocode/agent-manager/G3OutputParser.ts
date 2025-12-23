import { ParseResult, StreamEvent, KilocodePayload } from "./CliOutputParser"

enum ParseState {
    Idle,
    AgentResponse,
    ToolArgs,
    ToolOutput,
    FinalOutput,
}

export class G3OutputParser {
    private buffer: string = ""
    private state: ParseState = ParseState.Idle
    private currentToolName: string | null = null
    private currentToolArgs: Record<string, any> = {}
    private currentToolOutput: string = ""

    parse(chunk: string): ParseResult {
        this.buffer += chunk
        const lines = this.buffer.split("\n")
        // Keep last partial line in buffer
        this.buffer = lines.pop() || ""

        const events: StreamEvent[] = []

        for (const line of lines) {
            // Don't trim blindly, indentation might matter for python code etc.
            // But markers are typically at start of line?
            // MachineUiWriter uses println!, so markers are at start.
            const trimmed = line.trim()

            if (trimmed === "AGENT_RESPONSE:") {
                this.state = ParseState.AgentResponse
                continue
            } else if (trimmed.startsWith("TOOL_CALL:")) {
                this.state = ParseState.ToolArgs
                this.currentToolName = trimmed.substring("TOOL_CALL:".length).trim()
                this.currentToolArgs = {}
                continue
            } else if (trimmed.startsWith("TOOL_OUTPUT:")) {
                // Transition from ToolArgs to ToolOutput
                // First emit the tool_use event
                if (this.currentToolName) {
                    events.push({
                        streamEventType: "kilocode",
                        payload: {
                            type: "say",
                            say: "tool_use",
                            tool: this.currentToolName, // legacy field?
                            name: this.currentToolName,
                            params: this.currentToolArgs
                        } as unknown as KilocodePayload
                    })
                }
                this.state = ParseState.ToolOutput
                this.currentToolOutput = ""
                continue
            } else if (trimmed === "END_TOOL_OUTPUT") {
                // Emit tool result
                if (this.currentToolName) {
                    // Kilocode expects "tool_result" or similar?
                    // Actually Kilocode UI consumes "tool_use" and then waits for "user_result" or "browser_result" etc.
                    // If we are auto-executing, we should simulate the result coming back.
                    // The payload for result usually looks like: { type: "say", say: "tool_result", ... } ?
                    // Actually, usually the extension sends "tool" request, wait for "user" response.
                    // g3 is autonomous.
                    // We simply want to show the output.
                    // Maybe we send it as specific tool result if we can match an ID.
                    // Since we don't have IDs, we might just show it as text or log.
                    // But effectively we want the UI to update.
                    // Let's emit a 'browser_output' or just generic output?
                    // Assuming for now we just want to stream it.
                }
                this.state = ParseState.Idle
                this.currentToolName = null
                continue
            } else if (trimmed === "FINAL_OUTPUT:") {
                this.state = ParseState.FinalOutput
                continue
            }

            // Handle content based on state
            if (this.state === ParseState.AgentResponse) {
                // Emit streaming text
                events.push({
                    streamEventType: "kilocode",
                    payload: {
                        type: "say",
                        say: "text",
                        text: line + "\n", // Append newline as we split by it
                        partial: true
                    } as KilocodePayload
                })
            } else if (this.state === ParseState.ToolArgs) {
                if (trimmed.startsWith("TOOL_ARG:")) {
                    const content = trimmed.substring("TOOL_ARG:".length).trim()
                    const eqIndex = content.indexOf("=")
                    if (eqIndex !== -1) {
                        const key = content.substring(0, eqIndex).trim()
                        const value = content.substring(eqIndex + 1).trim()
                        this.currentToolArgs[key] = value
                    }
                }
            } else if (this.state === ParseState.ToolOutput) {
                // Collect tool output
                // We could stream this too?
                // "tool_output" event?
                this.currentToolOutput += line + "\n"
            } else if (this.state === ParseState.FinalOutput) {
                // Emit final output text
                events.push({
                    streamEventType: "kilocode",
                    payload: {
                        type: "say",
                        say: "text",
                        text: line + "\n",
                        partial: true,
                        isAnswered: true // Maybe?
                    } as KilocodePayload
                })
            } else if (trimmed.startsWith("CONTEXT_STATUS:")) {
                events.push({
                    streamEventType: "status",
                    message: trimmed.substring("CONTEXT_STATUS:".length).trim(),
                    timestamp: new Date().toISOString()
                })
            }
        }

        return { events, remainingBuffer: this.buffer }
    }

    flush(): ParseResult {
        // Flush remaining buffer if any
        return { events: [], remainingBuffer: "" }
    }

    reset(): void {
        this.buffer = ""
        this.state = ParseState.Idle
    }
}
