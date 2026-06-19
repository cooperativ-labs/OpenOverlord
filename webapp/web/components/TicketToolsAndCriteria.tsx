import { useUpdateTicket } from '../lib/queries.ts';

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion.tsx';
import { InlineEditField } from './InlineEditField.tsx';

interface TicketToolsAndCriteriaProps {
  ticketId: string;
  availableTools: string[];
  acceptanceCriteria: string | null;
}

const accordionTriggerClassName =
  'py-3 text-xs font-medium uppercase tracking-wide text-muted-foreground hover:no-underline';

export function TicketToolsAndCriteria({
  ticketId,
  availableTools,
  acceptanceCriteria
}: TicketToolsAndCriteriaProps) {
  const update = useUpdateTicket(ticketId);
  const toolsText = availableTools.join('\n');

  return (
    <Accordion multiple>
      <AccordionItem value="acceptance-criteria" className="not-last:border-b-0 ">
        <AccordionTrigger className={accordionTriggerClassName}>
          Acceptance Criteria
        </AccordionTrigger>
        <AccordionContent>
          <div className="pb-2 pl-2">
            <InlineEditField
              className="block text-sm leading-relaxed"
              value={acceptanceCriteria ?? ''}
              multiline
              ariaLabel="Acceptance criteria"
              placeholder="None specified — click to add."
              onSave={next => update.mutate({ acceptanceCriteria: next || null })}
            />
          </div>
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="tools" >
        <AccordionTrigger className={accordionTriggerClassName}>Tools</AccordionTrigger>
        <AccordionContent>
          <div className="pb-2 pl-2">
            <InlineEditField
              className="block text-sm leading-relaxed"
              value={toolsText}
              multiline
              ariaLabel="Available tools"
              placeholder="None specified — click to add."
              onSave={next => {
                const tools = next
                  .split('\n')
                  .map(line => line.trim())
                  .filter(Boolean);
                update.mutate({ availableTools: tools });
              }}
            />
          </div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
