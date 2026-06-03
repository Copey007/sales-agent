# A-Gent Social Agent — Spec v1

## What It Does
Manages LinkedIn presence for B2B SaaS clients: research, content creation, scheduling, engagement. Works alongside Content Agent.

## Inputs
- Client's LinkedIn profile / personal brand goals
- Target ICP (who they want to reach)
- Industry news sources to pull from
- Competitor accounts to track

## Weekly Outputs
1. **5 LinkedIn posts** (Monday, Tuesday, Wednesday, Thursday, Friday — one per day)
2. **Engagement targets** — list of 10 people to engage with that week (comment on their posts, react)
3. **Comment templates** — 3 pre-written comments for client to use on others' posts
4. **Trending content** — 2 industry news items pulled and turned into post hooks

## Workflow
```
Monday: Research week (industry news, ICP activity)
Tuesday: Agent drafts 5 posts + 3 comment templates
Wednesday: Client review in dashboard
Thursday: Client approves (or requests edits)
Friday: Posts scheduled via Buffer/Phantombuster API
```

## LinkedIn Post Strategy

### Content Mix (per week):
- 1 founder-voice personal story
- 1 "how to" educational post
- 1 hot take / counter-intuitive opinion
- 1 product insight (without being salesy)
- 1 engagement post (question, poll, "reply if you...")

### Hook Patterns (rotate weekly):
- "The #1 thing I see founders getting wrong about..."
- "Unpopular opinion: ..."
- "Just spent 3 hours researching [topic]. Here's what I found."
- "Nobody talks about the [X] elephant in the room."
- "If you're in [industry] and not doing [X], you're leaving [Y] on the table."

### CTA Patterns:
- "Reply with your experience — I read every one."
- "Drop a 🙌 if you've experienced this."
- "DM me and I'll send you the template."
- "Save this post — you'll need it next quarter."

## Engagement Strategy
- Identify 10 target profiles per week (prospects, peers, potential partners)
- Comment on their latest post using pre-written templates
- React to their content
- No cold outreach DMs unless client approves

## Tools
- LinkedIn API (via Phantombuster or MeetAlfred)
- Buffer (scheduling)
- Airtable (content calendar tracking)
- Client dashboard (approval queue)

## Pricing
- $5,000/month
- Includes 2 rounds of revisions per post
- 3-month minimum
- Client approves all posts before scheduling