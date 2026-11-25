const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const workflowPath = path.join(root, 'workflows', 'ai-email-classification.json');
const csvPath = path.join(root, 'google-sheets-template.csv');
const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));

const nodesByName = new Map(workflow.nodes.map((node) => [node.name, node]));
assert.equal(nodesByName.size, workflow.nodes.length, 'Node names must be unique');
assert.equal(workflow.active, false, 'Imported workflow must be inactive by default');

for (const [source, connectionTypes] of Object.entries(workflow.connections)) {
  assert(nodesByName.has(source), `Unknown connection source: ${source}`);
  for (const outputs of Object.values(connectionTypes)) {
    for (const links of outputs) {
      for (const link of links) {
        assert(nodesByName.has(link.node), `Unknown connection target: ${link.node}`);
      }
    }
  }
}

const csvHeaders = fs.readFileSync(csvPath, 'utf8').trim().split(',');
const sheetNode = nodesByName.get('Upsert Google Sheet');
const sheetHeaders = sheetNode.parameters.columns.schema.map((column) => column.id);
assert.deepEqual(sheetHeaders, csvHeaders, 'CSV and Google Sheets schemas must match');
assert.deepEqual(sheetNode.parameters.columns.matchingColumns, ['message_id']);

const normalizeCode = nodesByName.get('Normalize Email').parameters.jsCode;
const normalize = new Function('$input', normalizeCode);
const normalizedItems = normalize({
  all: () => [
    {
      json: {
        id: 'gmail-message-1',
        threadId: 'gmail-thread-1',
        headers: {
          From: 'Alice Example <alice@example.com>',
          Subject: 'Planning call',
          Date: '2026-11-25T10:00:00Z',
        },
        text: 'Can we schedule a call next Tuesday?',
      },
    },
  ],
});

assert.equal(normalizedItems.length, 1);
assert.equal(normalizedItems[0].json.message_id, 'gmail-message-1');
assert.equal(normalizedItems[0].json.sender_name, 'Alice Example');
assert.equal(normalizedItems[0].json.sender_email, 'alice@example.com');
assert.equal(normalizedItems[0].json.reply_to_email, 'alice@example.com');
assert.equal(normalizedItems[0].json.subject, 'Planning call');

const htmlOnlyItems = normalize({
  all: () => [
    {
      json: {
        id: 'gmail-message-2',
        from: 'Bob <bob@example.com>',
        subject: 'HTML only',
        text: '',
        html: '<p>Hello <strong>there</strong>.</p>',
      },
    },
  ],
});

assert.equal(htmlOnlyItems[0].json.body, 'Hello there .');

const validateCode = nodesByName.get('Validate AI Result').parameters.jsCode;
const validate = new Function('$input', validateCode);
const schedulingResult = {
  category: 'scheduling',
  priority: 'medium',
  sentiment: 'neutral',
  confidence: 0.94,
  summary: 'The sender wants to arrange a call.',
  reason: 'This is a direct scheduling request.',
  requires_response: true,
  draft_subject: 'Re: Planning call',
  draft_body: 'Thanks for reaching out. What times next Tuesday work for you?',
};

const validatedItems = validate({
  all: () => [
    {
      json: {
        ...normalizedItems[0].json,
        choices: [{ message: { content: JSON.stringify(schedulingResult) } }],
      },
    },
  ],
});

assert.equal(validatedItems[0].json.should_create_draft, true);
assert.equal(validatedItems[0].json.category, 'scheduling');

const newsletterItems = validate({
  all: () => [
    {
      json: {
        ...normalizedItems[0].json,
        choices: [
          {
            message: {
              content: JSON.stringify({
                ...schedulingResult,
                category: 'newsletter',
                requires_response: false,
                draft_subject: '',
                draft_body: '',
              }),
            },
          },
        ],
      },
    },
  ],
});

assert.equal(newsletterItems[0].json.should_create_draft, false);
assert.equal(newsletterItems[0].json.draft_body, '');

const buildAuditCode = nodesByName.get('Build Audit Row').parameters.jsCode;
const buildAudit = new Function('$json', '$', buildAuditCode);
const triage = validatedItems[0].json;
const auditWithDraft = buildAudit(
  { id: 'gmail-draft-1' },
  (nodeName) => {
    assert.equal(nodeName, 'Validate AI Result');
    return { item: { json: triage } };
  },
);

assert.equal(auditWithDraft.json.status, 'draft_created');
assert.equal(auditWithDraft.json.draft_id, 'gmail-draft-1');
assert.deepEqual(Object.keys(auditWithDraft.json), csvHeaders);

const manualReviewTriage = {
  ...triage,
  should_create_draft: false,
  draft_subject: '',
  draft_body: '',
};
const auditWithoutDraft = buildAudit(manualReviewTriage, () => {
  throw new Error('Cross-node lookup must not run on the no-draft path');
});

assert.equal(auditWithoutDraft.json.status, 'manual_review');
assert.equal(auditWithoutDraft.json.draft_created, false);

console.log(`Validated ${workflow.nodes.length} nodes, ${csvHeaders.length} Sheet columns, and both routing paths.`);
