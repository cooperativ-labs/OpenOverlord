import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildDeliveryReport } from './delivery-report.js';

type DeliveryReportFixture = {
  name: string;
  summary: string;
  deliveryReport?: unknown;
  expectedHumanActionCount?: number;
  expectedTradeoffCount?: number;
  valid?: boolean;
};

const fixtures = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../contract/delivery-report-v1-fixtures.json', import.meta.url)),
    'utf8'
  )
) as { cases: DeliveryReportFixture[] };

describe('delivery-report-v1 contract fixtures', () => {
  for (const fixture of fixtures.cases) {
    it(fixture.name, () => {
      if (fixture.valid === false) {
        assert.throws(
          () =>
            buildDeliveryReport({
              summary: fixture.summary,
              deliveryReport: fixture.deliveryReport
            }),
          /Invalid deliveryReport/
        );
        return;
      }

      const report = buildDeliveryReport({
        summary: fixture.summary,
        deliveryReport: fixture.deliveryReport
      });
      assert.equal(report.schemaVersion, 1);
      assert.equal(report.presentation.status, 'deterministic');
      assert.equal(report.presentation.markdown, fixture.summary);
      assert.equal(report.agentReport.humanActions.length, fixture.expectedHumanActionCount);
      assert.equal(report.agentReport.tradeoffsMade.length, fixture.expectedTradeoffCount);
      assert.deepEqual(report.presentation.humanActions, report.agentReport.humanActions);
      assert.deepEqual(report.presentation.tradeoffsMade, report.agentReport.tradeoffsMade);
    });
  }
});
