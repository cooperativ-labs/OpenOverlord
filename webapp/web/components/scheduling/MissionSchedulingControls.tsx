import type { MissionDetailDto } from '../../../shared/contract.ts';

import { DueDateEditor } from './DueDateEditor.tsx';
import { ScheduleEditor } from './ScheduleEditor.tsx';

export function MissionSchedulingControls({ mission }: { mission: MissionDetailDto }) {
  return (
    <>
      <DueDateEditor missionId={mission.id} initialDueDatetime={mission.dueDatetime} />
      <ScheduleEditor
        missionId={mission.id}
        hasSchedule={mission.scheduleId !== null}
        currentDueDatetime={mission.dueDatetime}
        statuses={mission.statuses}
      />
    </>
  );
}
