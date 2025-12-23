import { spawn, ChildProcess } from "node:child_process"
import {
    StreamEvent,
    SessionCreatedStreamEvent,
} from "./CliOutputParser"
import { AgentRegistry } from "./AgentRegistry"
import { G3OutputParser } from "./G3OutputParser" // Import new parser
import type { ClineMessage, ProviderSettings } from "@roo-code/types"
import { buildProviderEnvOverrides } from "./providerEnvMapper"

export interface G3ProcessHandlerCallbacks {
    onLog: (message: string) => void
    onDebugLog?: (message: string) => void
    onSessionLog: (sessionId: string, line: string) => void
    onStateChanged: () => void
    onPendingSessionChanged: (pendingSession: { prompt: string; label: string; startTime: number } | null) => void
    onStartSessionFailed: (error: any) => void
    onChatMessages: (sessionId: string, messages: ClineMessage[]) => void
    onSessionCreated: (sawApiReqStarted: boolean) => void
    onStatusMessage: (sessionId: string, message: string) => void
}

interface ActiveG3Process {
    process: ChildProcess
    parser: G3OutputParser
    sessionId: string
}

export class G3ProcessHandler {
    private activeSessions: Map<string, ActiveG3Process> = new Map()

    constructor(
        private readonly registry: AgentRegistry,
        private readonly callbacks: G3ProcessHandlerCallbacks,
    ) { }

    private debugLog(message: string): void {
        this.callbacks.onDebugLog?.(message)
    }

    public spawnProcess(
        binaryPath: string,
        workspace: string,
        prompt: string,
        options:
            | {
                sessionId?: string
                label?: string
                apiConfiguration?: ProviderSettings
            }
            | undefined,
        onCliEvent: (sessionId: string, event: StreamEvent) => void,
    ): void {
        const sessionId = options?.sessionId || `g3-${Date.now()}`

        // Update registry
        if (options?.sessionId) {
            this.registry.updateSessionStatus(sessionId, "creating")
        } else {
            this.registry.createSession(sessionId, prompt, Date.now(), {
                labelOverride: options?.label,
                // gitUrl? G3 might handle it differently or we pass it via args if G3 supports it
            })
        }

        const args = ["--machine", "--workspace", workspace]
        // G3 supports autonomous by default with prompting?
        // If we want autonomous mode:
        args.push("--autonomous")
        // Pass prompt as task or argument?
        // g3 <task>
        if (prompt) {
            args.push(prompt)
        }

        const env = {
            ...process.env,
            ...buildProviderEnvOverrides(options?.apiConfiguration, process.env, this.callbacks.onLog, this.debugLog),
            NO_COLOR: "1"
        }

        const proc = spawn(binaryPath, args, {
            cwd: workspace,
            env,
            stdio: ["pipe", "pipe", "pipe"]
        })

        const parser = new G3OutputParser()
        this.activeSessions.set(sessionId, { process: proc, parser, sessionId })

        if (proc.pid) {
            this.registry.setSessionPid(sessionId, proc.pid)
            this.registry.updateSessionStatus(sessionId, "running")

            // Emit session_created immediately as G3 starts running task immediately
            const sessionCreatedEvent: SessionCreatedStreamEvent = {
                streamEventType: "session_created",
                sessionId,
                timestamp: Date.now()
            }
            onCliEvent(sessionId, sessionCreatedEvent)
            this.callbacks.onSessionCreated(false) // No api_req_started concept yet
        }

        proc.stdout?.on("data", (chunk: Buffer) => {
            const chunkStr = chunk.toString()
            const { events } = parser.parse(chunkStr)
            for (const event of events) {
                onCliEvent(sessionId, event)
            }
        })

        proc.stderr?.on("data", (chunk: Buffer) => {
            const chunkStr = chunk.toString()
            this.debugLog(`stderr: ${chunkStr}`)
            // Maybe emit as status or error?
            // onCliEvent(sessionId, { streamEventType: "status", message: chunkStr, timestamp: ... })
        })

        proc.on("exit", (code: number | null) => {
            this.registry.updateSessionStatus(sessionId, code === 0 ? "done" : "error", code || 0)
            this.activeSessions.delete(sessionId)
            this.callbacks.onStateChanged()
        })

        proc.on("error", (err: Error) => {
            this.callbacks.onStartSessionFailed(err)
        })
    }

    public stopProcess(sessionId: string): void {
        const info = this.activeSessions.get(sessionId)
        if (info) {
            info.process.kill()
            this.activeSessions.delete(sessionId)
        }
    }
}
