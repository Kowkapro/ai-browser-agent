// === Multi-agent system types ===

export type SubtaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/** A single subtask produced by the Coordinator's decomposition */
export interface Subtask {
  id: number;
  description: string;
  status: SubtaskStatus;
  result?: string;
  retryCount: number;
  validationResult?: ValidationResult;
}

/** Classification result from the Coordinator */
export interface TaskClassification {
  complexity: 'simple' | 'complex';
  reasoning: string;
}

/** Decomposition result from the Coordinator */
export interface TaskDecomposition {
  subtasks: Subtask[];
  overallStrategy: string;
}

/** Worker's report back to the Coordinator */
export interface WorkerReport {
  success: boolean;
  result: string;
  steps: number;
  finalPageUrl: string;
}

/** Validator's assessment */
export interface ValidationResult {
  completed: boolean;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  suggestions?: string;
}

/** Overall result returned to index.ts */
export interface CoordinatorResult {
  success: boolean;
  result: string;
  totalSteps: number;
  subtasksCompleted: number;
  subtasksTotal: number;
}
