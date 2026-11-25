# AI Email Classification and Response Automation

An importable n8n workflow that:

- Polls Gmail for new inbox messages.
- Classifies each email with an OpenAI-compatible LLM API.
- Produces a summary, category, priority, sentiment, and response decision.
- Creates a Gmail reply draft when a response is appropriate.
- Upserts an audit record into Google Sheets.
- Applies an `AI/Processed` Gmail label after processing succeeds.

The workflow never sends email. A person reviews and sends each draft from Gmail.

## Project Files

- `workflows/ai-email-classification.json`: import this into n8n.
- `google-sheets-template.csv`: the exact Google Sheets header required by the workflow.

## Architecture

```text
Gmail Trigger
  -> Normalize Email
  -> OpenAI Email Triage
  -> Merge Email and AI
  -> Validate AI Result
  -> Create Reply Draft?
       true  -> Create Gmail Draft --+
       false ------------------------+-> Build Audit Row
                                          -> Upsert Google Sheet
                                          -> Add Processed Label
```

The default categories are:

`urgent`, `customer_support`, `sales`, `billing`, `scheduling`, `internal`, `newsletter`, `spam`, and `other`.

## Prerequisites

- An n8n Cloud account or a reachable self-hosted n8n instance.
- A Gmail or Google Workspace mailbox.
- A Google Sheet.
- An OpenAI API key with access to `gpt-4.1-mini`.
- Permission to create OAuth credentials if your n8n instance does not provide managed Google sign-in.

Use the current n8n release. The workflow uses current Gmail, HTTP Request, Code, Merge, IF, and Google Sheets node schemas.

## Setup

### 1. Create the Google Sheet

1. Create a blank Google spreadsheet.
2. Rename the first tab to `Email Log`.
3. Import `google-sheets-template.csv`, or paste its single header row into row 1.
4. Keep every header unchanged. The `message_id` column is the upsert key that prevents duplicate Sheet rows.
5. Copy the spreadsheet ID from its URL:

```text
https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit
```

### 2. Create the Gmail processed label

1. Open Gmail.
2. Create a label named `AI/Processed`.
3. Do not apply it to test emails before running the workflow.

The Gmail Trigger query is:

```text
in:inbox -from:me -label:AI/Processed
```

This ignores sent mail and messages already processed by the automation. It does not change the unread status of incoming messages.

### 3. Import the workflow

1. Open n8n.
2. Select **Create Workflow**.
3. Open the workflow menu, select **Import from File**, and choose `workflows/ai-email-classification.json`.
4. Leave the workflow inactive until every credential and placeholder is configured.

### 4. Connect Gmail

Create or select one Gmail OAuth2 credential and use it in these nodes:

- `Gmail Trigger`
- `Create Gmail Draft`
- `Add Processed Label`

For n8n Cloud, the credential screen normally provides Google sign-in directly. For self-hosted n8n, follow n8n's Google OAuth2 setup and add the OAuth redirect URL displayed by n8n to the Google Cloud OAuth client.

The Gmail credential needs permission to read messages, create drafts, and modify labels. n8n requests the appropriate scopes when its Gmail credential is connected.

### 5. Connect the LLM API

1. In n8n credentials, create a **Bearer Auth** credential.
2. Put the OpenAI API key in the token field. Enter the token itself, without adding `Bearer `.
3. Open `OpenAI Email Triage`.
4. Select that Bearer Auth credential.

The node calls:

```text
POST https://api.openai.com/v1/chat/completions
```

It requests strict JSON output from `gpt-4.1-mini`. To use another OpenAI model, change the `model` value in the request body. A different provider must support the OpenAI Chat Completions request shape and structured `json_schema` responses, or the request and parser must be adapted to that provider.

### 6. Connect Google Sheets

1. Open `Upsert Google Sheet`.
2. Select or create a Google Sheets OAuth2 credential.
3. Replace `REPLACE_WITH_SPREADSHEET_ID` by selecting the spreadsheet or entering its real ID.
4. Select the `Email Log` tab.
5. Refresh the node's column mapping if n8n asks. Keep **Auto-map Input Data to Columns** and match on `message_id`.

The Google credential must have edit access to the spreadsheet.

### 7. Configure the processed label node

1. Open `Add Processed Label`.
2. Remove `Label_REPLACE_WITH_PROCESSED_LABEL_ID`.
3. Select the real `AI/Processed` label from the label dropdown.
4. Confirm that **Message ID** remains `{{ $json.message_id }}`.

This node is intentionally last. An email is not marked as processed if classification, draft creation, or the Sheet write fails.

### 8. Test safely

1. Send the connected Gmail account a test message from another address.
2. Use a harmless message such as: `Can we schedule a 30-minute call next Tuesday afternoon?`
3. In n8n, select **Test Workflow** or execute the Gmail Trigger manually.
4. Inspect every node's output.
5. Confirm that Gmail contains a draft attached to the original thread.
6. Confirm that `Email Log` contains one row with `status` set to `draft_created`.
7. Confirm that Gmail applied `AI/Processed` to the incoming message.
8. Send a newsletter-style test. Confirm it is logged with no draft.
9. Only after both paths work, activate the workflow.

## How It Works

### 1. Gmail Trigger

The trigger polls Gmail every minute and returns at most ten messages per poll. It fetches full parsed message data but does not download attachment contents. Spam, trash, drafts, sent mail, and messages carrying `AI/Processed` are excluded.

### 2. Normalize Email

The first Code node handles the different shapes Gmail may use for headers and addresses. It extracts:

- Gmail message and thread IDs
- sender and reply-to addresses
- subject and received time
- plain-text body
- attachment names
- a direct Gmail URL

The email body is limited to 12,000 characters to control token use. Attachment contents are not sent to the LLM.

### 3. OpenAI Email Triage

The HTTP Request node sends normalized email data to the LLM. The system instruction treats all email content as untrusted data, which helps resist prompt injection contained in an email.

The LLM must return this structured result:

```json
{
  "category": "scheduling",
  "priority": "medium",
  "sentiment": "neutral",
  "confidence": 0.94,
  "summary": "The sender wants to schedule a call next Tuesday.",
  "reason": "This is a direct meeting request.",
  "requires_response": true,
  "draft_subject": "Re: Meeting next Tuesday",
  "draft_body": "Thanks for reaching out. What times next Tuesday afternoon work best for you?"
}
```

The prompt tells the model not to invent facts, pricing, availability, approvals, refunds, deadlines, or commitments.

### 4. Merge Email and AI

An HTTP Request replaces its input with the API response. This Merge node combines that response with the original normalized Gmail fields by item position.

### 5. Validate AI Result

The validation node rejects malformed JSON, unknown categories, invalid priorities, invalid sentiment, or confidence outside `0` to `1`. A failed validation stops the run before any label is applied.

A draft is allowed only when all conditions are true:

- The LLM says a response is required.
- The category is not `spam` or `newsletter`.
- The sender is not a recognized no-reply or automated address.
- A reply-to address and draft body exist.
- Confidence is at least `0.55`.

If a response may be needed but these checks block drafting, the Sheet status becomes `manual_review`.

### 6. Create Reply Draft?

The IF node routes response-worthy mail to Gmail draft creation. All other mail skips directly to the audit-row step.

### 7. Create Gmail Draft

The Gmail node creates a plain-text draft addressed to the normalized reply-to address. Supplying the Gmail thread ID attaches the draft to the original conversation. The node does not send it.

### 8. Build Audit Row

The second Code node reduces the execution data to the 20 fields in the spreadsheet. It records one of these statuses:

- `draft_created`: a Gmail draft exists.
- `manual_review`: the message appears to need a response, but a safety check blocked drafting.
- `no_response_needed`: no draft is necessary.

### 9. Upsert Google Sheet

The Google Sheets node uses **Append or Update Row** with `message_id` as the match key. Reprocessing the same Gmail message updates its row instead of appending a second row.

### 10. Add Processed Label

After the Sheet write succeeds, the workflow applies `AI/Processed`. The trigger query excludes this label, completing the processing loop.

## Sheet Columns

| Column | Meaning |
| --- | --- |
| `processed_at` | UTC time of the latest successful processing run |
| `message_id` | Unique Gmail message ID and Sheet upsert key |
| `thread_id` | Gmail conversation ID |
| `received_at` | Message receive time |
| `sender_name` | Parsed sender name |
| `sender_email` | Parsed sender address |
| `subject` | Original subject |
| `category` | LLM category |
| `priority` | `high`, `medium`, or `low` |
| `sentiment` | `positive`, `neutral`, or `negative` |
| `confidence` | Classification confidence from `0` to `1` |
| `summary` | Short email summary |
| `classification_reason` | Why the LLM chose the category |
| `requires_response` | LLM response decision |
| `draft_created` | Whether Gmail created a draft |
| `draft_id` | Gmail draft ID, when present |
| `draft_subject` | Generated subject, when present |
| `draft_body` | Generated plain-text response, when present |
| `status` | Final workflow status |
| `gmail_url` | Direct link to the Gmail message |

## Customization

### Change categories

Update all three locations together:

1. The category list in the `OpenAI Email Triage` system prompt.
2. The category enum in that node's JSON schema.
3. The `categories` set in `Validate AI Result`.

If a new category must never produce a draft, also add it to `suppressedCategories` in `Validate AI Result`.

### Change tone or business context

Edit the system message in `OpenAI Email Triage`. Add facts the model may safely use, such as business hours or a standard support greeting. Do not place secrets in the prompt.

### Change the confidence threshold

Edit this condition in `Validate AI Result`:

```javascript
confidence >= 0.55
```

Raise it to create fewer drafts, or lower it only after reviewing classification quality.

### Change the polling interval

Open `Gmail Trigger` and edit **Poll Times**. Keep **Max Emails per Poll** within Gmail and LLM rate limits.

## Security and Reliability

- Keep all API keys in n8n credentials, never in workflow fields or source files.
- Restrict access to n8n execution data because executions can contain email text.
- Restrict access to the Google Sheet because it stores summaries and generated drafts.
- Configure n8n execution-data retention according to your privacy requirements.
- Keep automatic sending disabled until drafts have been reviewed for a meaningful period.
- The workflow does not process attachment contents. Add malware scanning and an approved document extraction path before enabling that behavior.
- Google Sheets upsert prevents duplicate log rows. A rare failure after Gmail creates a draft but before the final label is added can still result in a duplicate draft on retry. Review n8n error executions before retrying failed runs.
- LLM classification is probabilistic. The strict schema and deterministic validator reduce risk but do not guarantee correct categorization.

## Troubleshooting

### The Gmail Trigger returns no email

- Confirm the message is in the inbox.
- Confirm it does not already have `AI/Processed`.
- Confirm it was not sent from the connected account.
- Temporarily run the Gmail search query directly in Gmail to see what it matches.

### OpenAI returns `401`

- Confirm `OpenAI Email Triage` uses a Bearer Auth credential.
- Store only the API key in the token field. Do not prepend `Bearer `.

### OpenAI returns `400`

- Confirm the account can use `gpt-4.1-mini`.
- If the selected model does not support strict `json_schema`, use a supported model or adapt the request and validation node.

### Google Sheets reports changed or missing columns

- Confirm the tab is named `Email Log`.
- Restore the exact header from `google-sheets-template.csv`.
- Re-select the document and sheet, then refresh the column mapping.

### The processed-label node fails

- Remove the placeholder label ID.
- Re-open the label selector after connecting the Gmail credential.
- Select the existing `AI/Processed` label from the list.

### A message is classified but has no draft

Check `status`, `requires_response`, `confidence`, category, and sender address in the Sheet. `manual_review` means a response was indicated but deterministic safety rules blocked draft creation.
