# Set up the support routine

You end up with this: a new conversation in your helpdesk becomes a Maplith
signal, Maplith wakes your relay, the relay starts your own Claude Code
routine, and the routine leaves a draft reply in the helpdesk for one of your
people to check and send. It never sends anything itself.

Nothing in this chain is held by Maplith. The routine is on your Claude
account and uses its usage. The routine's token lives in your relay and
nowhere else. Maplith sees the ids it names in a wake-up, and your routine
asks Maplith for the rest with its own key.

Allow about half an hour.

## Before you start

- A Maplith workspace where you are an admin who sees the whole map, and in
  which **Settings → Agent keys** shows a **Wake-ups** section.
- A helpdesk that Maplith reads, so that a new conversation raises a
  `support_case_opened` signal, and a connector for that helpdesk in Claude.
- A Claude plan with routines. Routines are available on Pro, Max, Team and
  Enterprise plans and belong to one person's claude.ai account. For a
  company's support work use a Team or Enterprise seat, or the
  managed-agents adapter with API credits (see the README): Pro and Max are
  plans for individuals.
- A place to run the relay (see the README).

## 1. Add the connectors (an Owner, on Team and Enterprise)

An Owner of your Claude organisation adds the two connectors the routine
needs, at claude.ai under Settings → Connectors:

- **Maplith**, as a custom connector with the address
  `https://app.maplith.com/api/mcp`.
- **Your helpdesk's** connector.

On an individual plan you add both yourself in step 2.

## 2. The routine's owner connects each one with their own account

The person who will own the routine opens Settings → Connectors on claude.ai
and connects both, signing in with their own account for each.

- **Maplith** asks which workspace the connection is for and what its key may
  do. Choose **Act with approval**: the routine needs to take a signal and to
  record what it did. In Maplith, open **Settings → Agent keys**, find the key
  this connection made and set it to **Hand over only**, so that it can hand a
  signal to a person and can never close one.
- **The helpdesk**: sign in with an account that has the fewest rights that
  still work, which is to read conversations and add internal notes. If the
  account cannot send a message to the person who wrote in, nothing the
  routine reads can make it.

## 3. Create the routine

At claude.ai/code/routines choose **New routine**.

1. **Name** it, for example "Support drafts".
2. **Instructions:** paste the whole of [PROMPT.md](PROMPT.md).
3. **Repository:** the routine needs no code. If the form asks for a
   repository, add an empty one of your own.
4. **Environment:** the Default one is enough. Connectors reach their services
   through Anthropic's servers, so no network setting changes.
5. **Connectors:** all your connected connectors are included by default.
   Remove every one but Maplith and your helpdesk. A routine can use every tool
   of a connector it holds without asking.
6. **Trigger:** add a **Schedule**, hourly, at a few minutes past the hour (for
   example 7 minutes past). It is the safety net: it finds any conversation a
   wake-up missed.
7. **Create** it.

Then open the routine, choose **Edit**, **Add another trigger**, **API**. Copy
the address it shows and press **Generate token**. The token is shown once.
Keep the address and the token for step 4. They go into your relay and
nowhere else: not into Maplith, a chat, a ticket or a note.

## 4. Run the relay

Deploy it as the README describes, with these settings:

| Setting | Value |
|---|---|
| `RELAY_ADAPTER` | `claude-code-routine` |
| `RELAY_ROUTINE_FIRE_URL` | the address from step 3 |
| `ROUTINE_TOKEN` | the token from step 3 |
| `ALERT_WEBHOOK_URL` | an https address that takes a JSON POST, to be told when the routine cannot be started (optional) |
| `MAPLITH_WAKE_SECRET` | a placeholder for now: any text of 16 characters or more |

The relay needs the signing secret to start, and Maplith shows the secret only
when the wake-up is made, which needs the relay's address. So start the relay
with the placeholder, make the wake-up in step 5, then replace the placeholder
with the real secret and restart the relay.

The relay's address for Maplith is `https://<where the relay runs>/wake`.

## 5. Make the wake-up in Maplith

**Settings → Agent keys → Wake-ups,** choose the key from step 2 and add a
wake-up:

- **Address to call:** the relay's address from step 4, ending in `/wake`.
- **Kinds of signal:** *A support case was opened in your helpdesk* (the kind
  `support_case_opened`).
- **Also wake it when a person decides on one of its requests:** off. The
  routine only prepares drafts.
- **Wait to gather signals into one wake-up:** how long Maplith collects a
  burst into one wake-up. Shorter is quicker; 60 seconds is the usual setting.
- **Most wake-ups a day:** the number you allow.

Save it and copy the **signing secret** at once: it is shown once. Put it into
the relay as `MAPLITH_WAKE_SECRET`, replacing the placeholder, and restart the
relay.

## 6. Test it

1. In the wake-up's menu choose **Send a test.** The relay answers 200 and starts
   nothing; Settings shows the test as delivered. If it shows a failure, the
   signing secret in the relay is not the one Maplith shows.
2. Open the routine and press **Run now** with no text. It runs as the hourly
   check. Open the run: it should list the open `support_case_opened` signals
   and leave drafts in the helpdesk. This tests the connectors and the prompt.
3. Write a test conversation to your helpdesk from an address of your own. A
   draft note should appear on it. Open the run from the routine's list to see
   what it did.

## What to know

- **Limits.** A routine accepts 30 starts an hour, shared with **Run now**,
  and an account 100 an hour. The relay stays under 30: it holds back what
  would pass the limit and sends it in the next start, with up to 50 ids in
  one. Each run uses your seat's usage.
- **Pause.** Set `RELAY_PAUSED=true` in the relay and restart it: wake-ups are
  answered and nothing is started. Or pause the wake-up in Maplith, or switch
  the routine off.
- **Replace the routine's token.** Press **Regenerate** on the routine's API
  trigger, put the new token into `ROUTINE_TOKEN` and restart the relay. The old
  token stops working at once.
- **Replace the signing secret.** Choose **New signing secret** in the wake-up's
  menu in Maplith. The old secret keeps signing for 24 hours. Set `MAPLITH_WAKE_SECRET` to
  `<new>,<old>`, restart the relay, and drop the old one later.
- **Why drafts only.** A routine runs tools without asking and reads text from
  people outside your company, so a message could try to steer it. The prompt
  forbids sending, and the accounts you connected cannot send either. Keep both.
