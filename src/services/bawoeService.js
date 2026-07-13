import { db } from "../db/connection.js";
import { BAWOE_ACTIONS } from "./bawoeActions.js";

// Helper to log node execution
async function logExecutionStep(executionId, nodeId, status, outputData, error = null) {
  await db.run(
    "INSERT INTO bawoe_logs (id, execution_id, node_id, status, output_data, error_message) VALUES (?, ?, ?, ?, ?, ?)",
    [`log_${Date.now()}_${Math.random()}`, executionId, nodeId, status, JSON.stringify(outputData), error ? error.message : null]
  );
}

// Evaluates a condition node (e.g. { field: "brand_id", operator: "==", value: "brd_cureka" })
function evaluateCondition(nodeData, context) {
  const { field, operator, value } = nodeData;
  const actualValue = context[field];
  
  switch(operator) {
    case '==': return actualValue == value;
    case '!=': return actualValue != value;
    case '>': return actualValue > value;
    case '<': return actualValue < value;
    default: return false;
  }
}

// Executes a single workflow instance
export async function executeWorkflow(workflow, payload) {
  const executionId = `exec_${Date.now()}_${Math.random()}`;
  
  await db.run(
    "INSERT INTO bawoe_executions (id, workflow_id, trigger_payload, status) VALUES (?, ?, ?, 'running')",
    [executionId, workflow.id, JSON.stringify(payload)]
  );

  let definition = workflow.definition;
  if (typeof definition === 'string') definition = JSON.parse(definition);
  
  const nodes = definition.nodes || [];
  const edges = definition.edges || [];
  
  // Find trigger node
  let currentNode = nodes.find(n => n.type === 'trigger');
  if (!currentNode) {
    await db.run("UPDATE bawoe_executions SET status = 'failed' WHERE id = ?", executionId);
    return;
  }

  const context = { ...payload }; // Execution context holds payload and outputs of previous steps
  
  try {
    await logExecutionStep(executionId, currentNode.id, 'success', { event: workflow.trigger_event });

    // Simple Graph Traversal
    while (currentNode) {
      // Find outgoing edges from current node
      const outgoingEdges = edges.filter(e => e.source === currentNode.id);
      if (outgoingEdges.length === 0) break; // End of workflow
      
      let nextEdge = outgoingEdges[0];
      
      // If previous node was a condition, we must follow the True or False path
      if (currentNode.type === 'condition') {
        const isTrue = evaluateCondition(currentNode.data, context);
        await logExecutionStep(executionId, currentNode.id, 'success', { evaluated: isTrue });
        // Assume sourceHandle "true" or "false" dictates the path
        nextEdge = outgoingEdges.find(e => e.sourceHandle === String(isTrue));
        if (!nextEdge) break; // No path defined for this outcome
      }

      currentNode = nodes.find(n => n.id === nextEdge.target);
      if (!currentNode) break;

      // Execute Action
      if (currentNode.type === 'action') {
        const actionFn = BAWOE_ACTIONS[currentNode.data.action];
        if (!actionFn) throw new Error(`Action ${currentNode.data.action} not found`);
        
        const result = await actionFn(currentNode.data.payload || {}, context);
        // Merge output into context for subsequent steps
        Object.assign(context, result);
        
        await logExecutionStep(executionId, currentNode.id, 'success', result);
      }
      
      // Delay (Placeholder for V1 - executes immediately)
      if (currentNode.type === 'delay') {
        await logExecutionStep(executionId, currentNode.id, 'success', { skipped: true, reason: 'V1 placeholder' });
      }
    }

    await db.run("UPDATE bawoe_executions SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?", executionId);
  } catch (err) {
    if (currentNode) {
      await logExecutionStep(executionId, currentNode.id, 'error', null, err);
    }
    await db.run("UPDATE bawoe_executions SET status = 'failed', completed_at = CURRENT_TIMESTAMP WHERE id = ?", executionId);
  }
}

// Global Trigger Entry Point
// This is the function called by Shopify Webhooks or internal CRM events
export async function triggerEvent(eventName, payload) {
  // Find all active workflows listening to this event
  const workflows = await db.all("SELECT * FROM bawoe_workflows WHERE status = 'active' AND trigger_event = ?", eventName);
  
  for (const wf of workflows) {
    // If workflow is brand-specific, verify payload matches
    if (wf.brand_id && wf.brand_id !== payload.brand_id) continue;
    
    // Spawn execution async
    executeWorkflow(wf, payload).catch(console.error);
  }
}
