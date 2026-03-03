import type { Message } from '../llm/provider.js';

const RECENT_STEPS_LIMIT = 8;

export class ConversationHistory {
  private messages: Message[] = [];
  private stepSummaries: string[] = [];
  private stepCount = 0;

  /** Total number of agent steps taken */
  getStepCount(): number {
    return this.stepCount;
  }

  /** Add any message to history */
  addMessage(message: Message): void {
    this.messages.push(message);
  }

  /** Record a completed tool step and generate a one-line summary */
  recordStep(toolName: string, toolArgs: Record<string, unknown>, resultData: string): void {
    this.stepCount++;
    const argsStr = summarizeArgs(toolName, toolArgs);
    this.stepSummaries.push(`Step ${this.stepCount}: ${toolName}(${argsStr}) → ${truncate(resultData, 80)}`);
  }

  /**
   * Build the message array for the next LLM call.
   * Strategy:
   *   - System message (added externally)
   *   - User task message (first user message)
   *   - If > RECENT_STEPS_LIMIT messages: older steps compressed into summaries
   *   - Last RECENT_STEPS_LIMIT assistant+tool pairs kept in full
   *   - Current page state appended as final user message (added externally)
   */
  buildMessages(): Message[] {
    if (this.messages.length === 0) return [];

    // Find the system message and initial user task
    const systemMsg = this.messages.find(m => m.role === 'system');
    const taskMsg = this.messages.find(m => m.role === 'user');

    // Find plan messages (pinned — never compressed away)
    const planMessages = this.findPlanMessages();

    // Pinned messages that are always preserved
    const pinned = new Set<Message>([systemMsg, taskMsg, ...planMessages].filter(Boolean) as Message[]);

    // Conversation messages (everything except pinned)
    const convMessages = this.messages.filter(m => !pinned.has(m));

    const result: Message[] = [];

    if (systemMsg) result.push(systemMsg);
    if (taskMsg) result.push(taskMsg);
    for (const pm of planMessages) result.push(pm);

    // Group conversation into "turns": each turn starts with an assistant message
    // and includes all following tool results + the next user message (page state).
    // This ensures we never break assistant→tool pairs.
    const turns: Message[][] = [];
    let currentTurn: Message[] = [];

    for (const msg of convMessages) {
      if (msg.role === 'assistant' && currentTurn.length > 0) {
        turns.push(currentTurn);
        currentTurn = [];
      }
      currentTurn.push(msg);
    }
    if (currentTurn.length > 0) turns.push(currentTurn);

    if (turns.length > RECENT_STEPS_LIMIT) {
      // Number of turns being dropped
      const droppedTurns = turns.length - RECENT_STEPS_LIMIT;
      // Use the same number for summary slicing (capped to available summaries)
      const summaryCount = Math.min(droppedTurns, this.stepSummaries.length);
      if (summaryCount > 0) {
        const summaryText = this.stepSummaries.slice(0, summaryCount).join('\n');
        result.push({
          role: 'user',
          content: [{ type: 'text', text: `Previous actions summary:\n${summaryText}` }],
        });
      }

      // Keep recent turns in full (each turn = assistant + tools + user)
      const recentTurns = turns.slice(-RECENT_STEPS_LIMIT);
      for (const turn of recentTurns) {
        result.push(...turn);
      }
    } else {
      // Everything fits — keep all
      result.push(...convMessages);
    }

    return result;
  }

  /** Find plan-related messages (assistant "My plan:" + user "Good plan...") */
  private findPlanMessages(): Message[] {
    const plan: Message[] = [];
    for (const msg of this.messages) {
      if (msg.role === 'assistant' && msg.content.some(c => c.type === 'text' && 'text' in c && (c as any).text?.startsWith('My plan:'))) {
        plan.push(msg);
      } else if (msg.role === 'user' && msg.content.some(c => c.type === 'text' && 'text' in c && (c as any).text?.startsWith('Good plan.'))) {
        plan.push(msg);
      }
    }
    return plan;
  }

  /** Detect if the agent is looping (repeated actions or oscillation patterns) */
  isLooping(): boolean {
    const getAction = (s: string) => s.split('→')[0].replace(/Step \d+: /, '').trim();

    // Pattern 1: Same action 3x in a row (A-A-A)
    if (this.stepSummaries.length >= 3) {
      const last3 = this.stepSummaries.slice(-3).map(getAction);
      if (last3[0] === last3[1] && last3[1] === last3[2]) return true;
    }

    // Pattern 2: Two-action oscillation (A-B-A-B)
    if (this.stepSummaries.length >= 4) {
      const last4 = this.stepSummaries.slice(-4).map(getAction);
      if (last4[0] === last4[2] && last4[1] === last4[3] && last4[0] !== last4[1]) return true;
    }

    return false;
  }
}

function summarizeArgs(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'navigate':      return `"${args.url}"`;
    case 'click':         return `ref=${args.ref}`;
    case 'type_text':     return `ref=${args.ref}, "${args.text}"`;
    case 'select_option': return `ref=${args.ref}, "${args.option}"`;
    case 'scroll':        return `"${args.direction}"`;
    case 'wait':          return `${args.seconds}s`;
    case 'done':          return `"${truncate(String(args.result || ''), 50)}"`;
    default:              return JSON.stringify(args);
  }
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + '...';
}
