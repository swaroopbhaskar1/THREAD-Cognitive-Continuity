export const missionColumns = `m.id,m.title,m.subject,m.goal,m.created_at AS "createdAt",m.updated_at AS "updatedAt",
  (SELECT COUNT(*)::int FROM checkpoints cp WHERE cp.mission_id=m.id) AS "checkpointCount",
  COALESCE((SELECT next_action FROM drafts d WHERE d.mission_id=m.id),'') AS "nextAction"`;
export const draftColumns = `notes,understanding,questions,reasoning,next_action AS "nextAction",version,saved_at AS "savedAt"`;
export const checkpointColumns = `id,mission_id AS "missionId",notes,understanding,questions,reasoning,
  next_action AS "nextAction",recall_question AS "recallQuestion",created_at AS "createdAt",source,workflow_id AS "workflowId"`;
export const workflowColumns = `id,operation,status,created_at AS "createdAt",duration_ms AS "durationMs",mission_id AS "missionId"`;
export const eventColumns = `id,workflow_id AS "workflowId",sequence,name,component,outcome,duration_ms AS "durationMs",
  created_at AS "createdAt",details,attempt,fallback,source_component AS "sourceComponent",destination_component AS "destinationComponent"`;
export const resumptionColumns = `id,mission_id AS "missionId",obstacle,strategy,started_at AS "startedAt",first_action_ms AS "firstActionMs"`;
