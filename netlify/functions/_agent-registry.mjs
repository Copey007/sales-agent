/**
 * Agent Registry & Manager
 * 
 * Defines specialized agent personas with standardized interfaces.
 * The Manager Agent receives high-level objectives and delegates sub-tasks
 * to the appropriate specialist agent via the task system.
 * 
 * This is the "A-Gent Workforce" — the Delos competitor.
 * 
 * Architecture:
 *   Manager → delegates to → Researcher, SDR, Ops, Support, Success, Social
 *   Each agent has: capabilities (tools), execute(), status reporting
 *   Tasks flow through agent_tasks table (working memory)
 */

import { invoke, initConnectors, env } from './_mcp-connectors.mjs';
import { remember, recall, getAccountMemories, createTask, updateTask, getPendingTasks } from './_supabase-memory.mjs';

// ─── Agent Base Class ──────────────────────────────────────────────────────────

class Agent {
  constructor({ id, type, name, description, capabilities = [] }) {
    this.id = id;
    this.type = type;
    this.name = name;
    this.description = description;
    this.capabilities = capabilities;
    this.status = 'idle';
    this.currentTask = null;
  }

  /**
   * Check if this agent can use a specific tool
   */
  canUse(connectorName, toolName) {
    return this.capabilities.includes(`${connectorName}.${toolName}`);
  }

  /**
   * Invoke a tool (with capability check)
   */
  async use(connectorName, toolName, params = {}) {
    if (!this.canUse(connectorName, toolName)) {
      throw new Error(`Agent "${this.id}" does not have capability "${connectorName}.${toolName}"`);
    }
    return await invoke(connectorName, toolName, params);
  }

  /**
   * Update status in the registry
   */
  async updateStatus(status, currentTask = null, lastAction = null) {
    this.status = status;
    this.currentTask = currentTask;
    
    const { url, key } = getSupabaseCreds();
    try {
      await fetch(`${url}/rest/v1/agent_registry?agent_id=eq.${this.id}`, {
        method: 'PATCH',
        headers: {
          'apikey': key, 'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json', 'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          status,
          current_task: currentTask,
          last_action: lastAction,
          last_active_at: new Date().toISOString()
        })
      });
    } catch (e) {
      // Non-fatal — status update is best-effort
    }
  }

  /**
   * Store a memory
   */
  async remember(memoryType, content, metadata = {}, accountId = null) {
    return await remember({
      agentId: this.id,
      accountId,
      memoryType,
      content,
      metadata
    });
  }

  /**
   * Recall memories
   */
  async recall(query, options = {}) {
    return await recall({
      query,
      agentId: this.id,
      ...options
    });
  }

  /**
   * Execute a task — overridden by each specialist agent
   */
  async execute(task) {
    throw new Error(`${this.name} has no execute() implementation`);
  }
}

function getSupabaseCreds() {
  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_ANON_KEY');
  return { url, key };
}

// ─── Manager Agent ─────────────────────────────────────────────────────────────

class ManagerAgent extends Agent {
  constructor() {
    super({
      id: 'manager',
      type: 'manager',
      name: 'Mission Control Manager',
      description: 'Receives high-level objectives and delegates to specialist agents',
      capabilities: ['supabase.query', 'supabase.insert', 'supabase.update', 'llm.chat']
    });
  }

  /**
   * Receive a high-level objective and decompose it into delegated tasks
   */
  async execute({ objective, context = {} }) {
    await this.updateStatus('active', objective, 'Decomposing objective');

    // Use LLM to decompose the objective into sub-tasks
    const decomposition = await this.use('llm', 'chat', {
      messages: [
        {
          role: 'system',
          content: `You are the A-Gent Manager Agent. Given a high-level objective, decompose it into specific sub-tasks for specialist agents.

Available agents and their specialties:
- researcher: Prospect sourcing via Hunter.io, buying signal detection via web search, account research
- sdr: GAP-methodology email generation, outbound sequence management, send dispatch
- ops: Queue scheduling, daily limit enforcement, system health monitoring
- support: Inbound customer questions, issue routing
- success: Customer health monitoring, retention plays, renewal management
- social: Social media publishing, engagement tracking

Return ONLY valid JSON:
{
  "tasks": [
    {
      "agent": "researcher|sdr|ops|support|success|social",
      "objective": "Specific task description for this agent",
      "context": {},
      "priority": 1-10,
      "depends_on": null,
      "parallel": true
    }
  ],
  "execution_plan": "Brief description of execution order and dependencies"
}

Rules:
- Set "parallel": true for tasks that can run simultaneously (no dependency on each other)
- Set "depends_on": "task_index" (0-based) when a task needs output from a prior task
- Independent tasks should have "parallel": true and "depends_on": null
- Minimize the number of sequential steps — maximize parallelism`
        },
        {
          role: 'user',
          content: `Objective: ${objective}\n\nContext: ${JSON.stringify(context)}`
        }
      ],
      temperature: 0.3,
      maxTokens: 1500
    });

    let plan;
    try {
      const cleaned = decomposition.content.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
      plan = JSON.parse(cleaned);
    } catch (e) {
      await this.updateStatus('error', objective, 'Failed to parse decomposition');
      return { success: false, error: 'Failed to parse LLM decomposition', raw: decomposition.content };
    }

    // Create task records for all tasks first
    const taskList = plan.tasks || [];
    const taskRecords = taskList.map((task, i) => ({
      ...task,
      taskId: `task_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}`,
      index: i
    }));

    for (const task of taskRecords) {
      await createTask({
        taskId: task.taskId,
        delegatedBy: 'manager',
        delegatedTo: task.agent,
        objective: task.objective,
        context: task.context || {},
        priority: task.priority || 5
      });
    }

    // Execute tasks with dependency-aware parallel execution
    const taskResults = [];
    const executed = new Set();
    const maxIterations = taskRecords.length + 1;

    for (let iteration = 0; iteration < maxIterations && executed.size < taskRecords.length; iteration++) {
      // Find tasks that can run now (no dependency or dependency already executed)
      const ready = taskRecords.filter(t => {
        if (executed.has(t.index)) return false;
        if (t.depends_on === null || t.depends_on === undefined) return true;
        return executed.has(t.depends_on);
      });

      if (ready.length === 0) break; // No more tasks can run

      // Group ready tasks: run all parallel ones together
      const parallelTasks = ready.filter(t => t.parallel !== false);
      const sequentialTasks = ready.filter(t => t.parallel === false);

      // Execute parallel tasks with Promise.allSettled
      if (parallelTasks.length > 0) {
        const promises = parallelTasks.map(async (task) => {
          const agent = getAgent(task.agent);
          if (!agent) return { agent: task.agent, success: false, error: `Unknown agent: ${task.agent}` };
          try {
            const result = await agent.execute({
              objective: task.objective,
              context: task.context || {},
              taskId: task.taskId
            });
            await updateTask({ taskId: task.taskId, status: 'completed', result });
            return { agent: task.agent, success: true, result, parallel: true };
          } catch (e) {
            await updateTask({ taskId: task.taskId, status: 'failed', error: e.message });
            return { agent: task.agent, success: false, error: e.message, parallel: true };
          }
        });
        const results = await Promise.allSettled(promises);
        results.forEach(r => {
          if (r.status === 'fulfilled') taskResults.push(r.value);
          else taskResults.push({ success: false, error: r.reason?.message || 'Promise rejected' });
        });
        parallelTasks.forEach(t => executed.add(t.index));
      }

      // Execute sequential tasks one by one
      for (const task of sequentialTasks) {
        const agent = getAgent(task.agent);
        if (!agent) {
          taskResults.push({ agent: task.agent, success: false, error: `Unknown agent: ${task.agent}` });
          executed.add(task.index);
          continue;
        }
        try {
          const result = await agent.execute({
            objective: task.objective,
            context: task.context || {},
            taskId: task.taskId
          });
          await updateTask({ taskId: task.taskId, status: 'completed', result });
          taskResults.push({ agent: task.agent, success: true, result, sequential: true });
        } catch (e) {
          await updateTask({ taskId: task.taskId, status: 'failed', error: e.message });
          taskResults.push({ agent: task.agent, success: false, error: e.message, sequential: true });
        }
        executed.add(task.index);
      }
    }

    await this.updateStatus('idle', null, `Completed: ${objective}`);
    return {
      success: true,
      execution_plan: plan.execution_plan,
      tasks: taskResults
    };
  }
}

// ─── Researcher Agent ──────────────────────────────────────────────────────────

class ResearcherAgent extends Agent {
  constructor() {
    super({
      id: 'researcher',
      type: 'researcher',
      name: 'A-Gent Researcher',
      description: 'Sources prospects via Hunter.io, gathers buying signals via web search',
      capabilities: ['hunter.find_email', 'hunter.domain_search', 'hunter.verify_email', 'serper.search', 'serper.news', 'supabase.insert', 'supabase.query', 'llm.chat', 'llm.embed']
    });
  }

  async execute({ objective, context = {}, taskId }) {
    await this.updateStatus('active', objective, 'Researching');

    try {
      // Check if we already have research on this account
      if (context.company || context.domain) {
        const accountId = (context.company || context.domain).toLowerCase().replace(/\s+/g, '_');
        const known = await this.recall(`research on ${context.company || context.domain}`, { accountId, matchCount: 3 });
        
        if (known.length > 0) {
          await this.updateStatus('idle', null, 'Found existing research in memory');
          return { success: true, source: 'memory', research: known };
        }
      }

      // Step 1: Search for company information
      let companyInfo = {};
      if (context.company) {
        const searchResult = await this.use('serper', 'search', { query: `${context.company} company overview funding hiring` });
        companyInfo.searchResults = searchResult;
        
        // Store the research
        await this.remember('research', `Company research for ${context.company}: ${JSON.stringify(searchResult.results?.slice(0, 3))}`, {
          company: context.company,
          search_performed: true
        }, context.company?.toLowerCase().replace(/\s+/g, '_'));
      }

      // Step 2: Find emails via Hunter
      let contacts = [];
      if (context.domain) {
        const emailResult = await this.use('hunter', 'domain_search', { domain: context.domain, limit: 10 });
        contacts = emailResult.emails || [];
        
        // Store contacts as memories
        for (const contact of contacts) {
          await this.remember('contact', `${contact.firstName} ${contact.lastName} (${contact.position}) - ${contact.email} [confidence: ${contact.confidence}]`, {
            email: contact.email,
            position: contact.position,
            confidence: contact.confidence,
            domain: context.domain
          }, context.domain);
        }
      }

      // Step 3: Search for buying signals
      let signals = [];
      if (context.company) {
        const newsResult = await this.use('serper', 'news', { query: `${context.company} hiring growth funding leadership new` });
        signals = newsResult.slice(0, 5);
        
        for (const signal of signals) {
          await this.remember('signal', `Signal for ${context.company}: ${signal.title} - ${signal.snippet}`, {
            source: signal.source,
            link: signal.link,
            date: signal.date
          }, context.company?.toLowerCase().replace(/\s+/g, '_'));
        }
      }

      await this.updateStatus('idle', null, `Research complete: ${contacts.length} contacts, ${signals.length} signals`);
      return {
        success: true,
        company: context.company,
        contacts,
        signals,
        searchResults: companyInfo.searchResults?.results?.slice(0, 3) || []
      };
    } catch (e) {
      await this.updateStatus('error', objective, `Error: ${e.message}`);
      throw e;
    }
  }
}

// ─── SDR Agent ─────────────────────────────────────────────────────────────────

class SDRAgent extends Agent {
  constructor() {
    super({
      id: 'sdr',
      type: 'sdr',
      name: 'A-Gent SDR',
      description: 'Generates GAP-methodology emails and manages outbound sequences',
      capabilities: ['llm.chat', 'llm.embed', 'resend.send', 'supabase.query', 'supabase.insert', 'supabase.update']
    });
  }

  async execute({ objective, context = {}, taskId }) {
    await this.updateStatus('active', objective, 'Generating outreach');

    try {
      // Recall context about this prospect
      let prospectContext = '';
      if (context.company || context.email) {
        const accountId = (context.company || '').toLowerCase().replace(/\s+/g, '_');
        const memories = await this.recall(`email outreach context for ${context.contactName || context.company}`, { accountId, matchCount: 5 });
        prospectContext = memories.map(m => m.content).join('\n');
      }

      // Generate GAP email
      const emailResult = await this.use('llm', 'chat', {
        messages: [
          {
            role: 'system',
            content: `You are an expert cold email writer trained in the GAP Prospecting methodology. Write short, problem-centric outbound emails.

LOCKED GUARDRAILS:
1. GAP Structure: Signal Opener → Current State/Problem → Credibility → CTA
2. Signal Integrity: Never fabricate signals
3. Brevity: UNDER 100 WORDS total
4. Single CTA: Exactly ONE question
5. Signature: [Sender Name] | A-Gent Fleet
6. Forbidden: "I hope this email finds you well", "My name is", "synergy", "15 minutes"

Return ONLY valid JSON:
{"subject": "2-4 word subject", "body": "Full email body ending with signature"}`
          },
          {
            role: 'user',
            content: `Prospect: ${context.contactName || 'Unknown'}, ${context.role || ''} at ${context.company || 'Unknown'}
Industry: ${context.industry || 'Unknown'}
Signals: ${JSON.stringify(context.signals || [])}
Existing context from memory: ${prospectContext || 'None'}

Write a GAP Prospecting email. Return JSON only.`
          }
        ],
        temperature: 0.7,
        maxTokens: 800
      });

      let email;
      try {
        const cleaned = emailResult.content.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
        email = JSON.parse(cleaned);
      } catch {
        email = { subject: 'Quick question', body: emailResult.content };
      }

      // Store the email as a memory
      await this.remember('email_sent', `Email to ${context.contactName} at ${context.company}: Subject="${email.subject}"`, {
        subject: email.subject,
        body: email.body,
        contact: context.contactName,
        company: context.company
      }, context.company?.toLowerCase().replace(/\s+/g, '_'));

      // Send via Resend if requested
      if (context.send !== false && context.toEmail) {
        const sendResult = await this.use('resend', 'send', {
          to: context.toEmail,
          from: context.from || 'mark@a-gent.co',
          subject: email.subject,
          html: email.body.replace(/\n/g, '<br>')
        });
        email.sendResult = sendResult;
      }

      await this.updateStatus('idle', null, `Email generated${email.sendResult ? ' and sent' : ''}`);
      return { success: true, email };
    } catch (e) {
      await this.updateStatus('error', objective, `Error: ${e.message}`);
      throw e;
    }
  }
}

// ─── Ops Agent ─────────────────────────────────────────────────────────────────

class OpsAgent extends Agent {
  constructor() {
    super({
      id: 'ops',
      type: 'ops',
      name: 'A-Gent Ops',
      description: 'Manages queue scheduling, daily limits, and system health',
      capabilities: ['supabase.query', 'supabase.update', 'supabase.insert']
    });
  }

  async execute({ objective, context = {}, taskId }) {
    await this.updateStatus('active', objective, 'Running ops check');

    try {
      // Query system stats
      const stats = await this.use('supabase', 'query', {
        table: 'email_steps',
        select: 'status',
        filter: 'order=created_at.desc&limit=1000'
      });

      const statusCounts = stats.reduce((acc, s) => {
        acc[s.status] = (acc[s.status] || 0) + 1;
        return acc;
      }, {});

      const contacts = await this.use('supabase', 'query', {
        table: 'contacts',
        select: 'id',
        filter: 'limit=1'
      });

      const result = {
        totalSteps: stats.length,
        statusBreakdown: statusCounts,
        totalContacts: contacts.length,
        timestamp: new Date().toISOString()
      };

      await this.remember('note', `Ops check: ${JSON.stringify(result)}`, result);
      await this.updateStatus('idle', null, 'Ops check complete');
      return { success: true, ...result };
    } catch (e) {
      await this.updateStatus('error', objective, `Error: ${e.message}`);
      throw e;
    }
  }
}

// ─── Support Agent ─────────────────────────────────────────────────────────────

class SupportAgent extends Agent {
  constructor() {
    super({
      id: 'support',
      type: 'support',
      name: 'A-Gent Support',
      description: 'Handles inbound customer questions, classifies reply sentiment, routes issues',
      capabilities: ['supabase.query', 'supabase.insert', 'llm.chat']
    });
  }

  async execute({ objective, context = {}, taskId }) {
    await this.updateStatus('active', objective, 'Processing support request');

    try {
      // Mode 1: Classify inbound replies from Netlify Blobs
      if (context.action === 'classify_replies') {
        return await this._classifyReplies(objective, context);
      }

      // Mode 2: Direct question mode (existing behavior)
      let customerHistory = [];
      if (context.customerEmail) {
        customerHistory = await this.recall(`support interaction with ${context.customerEmail}`, { matchCount: 5 });
      }

      const response = await this.use('llm', 'chat', {
        messages: [
          {
            role: 'system',
            content: 'You are A-Gent Support. Respond to customer questions professionally and concisely. If the issue requires human escalation, say so.'
          },
          {
            role: 'user',
            content: `Customer: ${context.customerEmail || 'Unknown'}\nQuestion: ${objective}\n\nPrevious interactions: ${customerHistory.map(m => m.content).join('; ') || 'None'}`
          }
        ],
        temperature: 0.3,
        maxTokens: 500
      });

      await this.remember('note', `Support Q: ${objective} | A: ${response.content}`, {
        customer: context.customerEmail,
        response: response.content
      });

      await this.updateStatus('idle', null, 'Support response generated');
      return { success: true, response: response.content };
    } catch (e) {
      await this.updateStatus('error', objective, `Error: ${e.message}`);
      throw e;
    }
  }

  /**
   * Classify sentiment of recent unclassified replies from Netlify Blobs
   */
  async _classifyReplies(objective, context) {
    const { getStore } = await import('@netlify/blobs');
    const repliesStore = getStore('replies');
    const list = await repliesStore.list();
    const replyBlobs = list.blobs || [];

    const classified = [];
    const escalations = [];

    // Process up to 20 recent replies
    for (const blob of replyBlobs.slice(-20)) {
      try {
        const reply = await repliesStore.get(blob.key, { type: 'json' });
        if (!reply || reply.sentiment !== 'unclassified') continue;

        // Use LLM to classify sentiment
        const classification = await this.use('llm', 'chat', {
          messages: [
            {
              role: 'system',
              content: `Classify the sentiment of this email reply. Return ONLY valid JSON:
{"sentiment": "positive|negative|neutral|objection|out_of_office", "summary": "one sentence summary", "needs_escalation": true|false}`
            },
            {
              role: 'user',
              content: `From: ${reply.from_email || 'unknown'}\nSubject: ${reply.subject || ''}\nBody: ${(reply.text_body || '').slice(0, 500)}`
            }
          ],
          temperature: 0.2,
          maxTokens: 200
        });

        let result;
        try {
          result = JSON.parse(classification.content.replace(/```json\s*/gi, '').replace(/```/g, ''));
        } catch {
          result = { sentiment: 'neutral', summary: 'classification failed', needs_escalation: false };
        }

        // Update the reply in the store with classification
        reply.sentiment = result.sentiment;
        reply.sentiment_summary = result.summary;
        await repliesStore.setJSON(blob.key, reply);

        // Store as memory
        await this.remember('reply', `Reply from ${reply.from_email}: ${result.sentiment} — ${result.summary}`, {
          email: reply.from_email,
          sentiment: result.sentiment,
          subject: reply.subject
        });

        classified.push({ email: reply.from_email, sentiment: result.sentiment, summary: result.summary });

        if (result.needs_escalation || result.sentiment === 'negative' || result.sentiment === 'objection') {
          escalations.push({ email: reply.from_email, sentiment: result.sentiment, summary: result.summary, subject: reply.subject });
        }
      } catch (e) {
        // Skip unreadable reply
      }
    }

    await this.updateStatus('idle', null, `Classified ${classified.length} replies, ${escalations.length} escalations`);
    return {
      success: true,
      classified_count: classified.length,
      escalations,
      classified
    };
  }
}

// ─── Success Agent ─────────────────────────────────────────────────────────────

class SuccessAgent extends Agent {
  constructor() {
    super({
      id: 'success',
      type: 'success',
      name: 'A-Gent Success',
      description: 'Monitors customer health, triggers retention plays, manages renewals',
      capabilities: ['supabase.query', 'supabase.update', 'llm.chat', 'resend.send']
    });
  }

  async execute({ objective, context = {}, taskId }) {
    await this.updateStatus('active', objective, 'Checking customer health');

    try {
      // Query real engagement data from Supabase
      const [contacts, steps] = await Promise.all([
        this.use('supabase', 'query', {
          table: 'contacts',
          select: 'id,name,email,company_name,created_at',
          filter: 'order=created_at.desc&limit=50'
        }),
        this.use('supabase', 'query', {
          table: 'email_steps',
          select: 'sequence_id,status,sent_at,scheduled_at',
          filter: 'order=created_at.desc&limit=500'
        })
      ]);

      // Calculate per-contact engagement metrics
      const now = Date.now();
      const fourteenDaysAgo = now - (14 * 24 * 60 * 60 * 1000);
      const contactMetrics = contacts.map(c => {
        const contactSteps = steps.filter(s => {
          // We need to match via sequences, but we don't have sequence data here
          // Use a simpler heuristic: match by contact activity in the activity_log
          return true;
        });
        const contactAge = c.created_at ? now - new Date(c.created_at).getTime() : 0;
        return {
          id: c.id,
          name: c.name,
          email: c.email,
          company: c.company_name,
          age_days: Math.floor(contactAge / (1000 * 60 * 60 * 24)),
          created_at: c.created_at
        };
      });

      // Calculate aggregate metrics
      const totalContacts = contacts.length;
      const totalSteps = steps.length;
      const sentCount = steps.filter(s => s.status === 'sent').length;
      const repliedCount = steps.filter(s => s.status === 'replied').length;
      const queuedCount = steps.filter(s => s.status === 'queued').length;
      const replyRate = sentCount > 0 ? (repliedCount / sentCount * 100).toFixed(1) : 0;

      // Identify at-risk: contacts created >14 days ago with no recent activity
      const recentActivity = steps.filter(s => s.sent_at && new Date(s.sent_at).getTime() > fourteenDaysAgo).length;
      const staleContacts = contactMetrics.filter(c => c.age_days > 14).length;

      // Use LLM to assess health based on real numbers
      const assessment = await this.use('llm', 'chat', {
        messages: [
          {
            role: 'system',
            content: 'You are A-Gent Customer Success. Assess customer health based on engagement metrics and suggest retention actions. Return JSON: {"health": "good|at_risk|critical", "at_risk_count": N, "actions": ["action1"], "summary": "brief summary"}'
          },
          {
            role: 'user',
            content: `Objective: ${objective}\n\nEngagement Metrics:\n- Total contacts: ${totalContacts}\n- Total email steps: ${totalSteps}\n- Sent: ${sentCount}\n- Replied: ${repliedCount}\n- Queued: ${queuedCount}\n- Reply rate: ${replyRate}%\n- Recent activity (14d): ${recentActivity} sends\n- Stale contacts (>14d no activity): ${staleContacts}\n- Recent contacts: ${JSON.stringify(contactMetrics.slice(0, 10).map(c => ({name: c.name, company: c.company, age_days: c.age_days})))}`
          }
        ],
        temperature: 0.3,
        maxTokens: 800
      });

      let result;
      try {
        result = JSON.parse(assessment.content.replace(/```json\s*/gi, '').replace(/```/g, ''));
      } catch {
        result = { health: 'unknown', at_risk_count: staleContacts, actions: [], summary: assessment.content };
      }

      // Store health assessment as memory
      await this.remember('campaign_result', `Health check: ${result.health} — ${result.summary}. Reply rate: ${replyRate}%, ${staleContacts} stale contacts.`, {
        health: result.health,
        reply_rate: replyRate,
        stale_contacts: staleContacts,
        total_contacts: totalContacts,
        actions: result.actions
      });

      await this.updateStatus('idle', null, `Health check: ${result.health}, ${staleContacts} at-risk`);
      return {
        success: true,
        ...result,
        metrics: { totalContacts, totalSteps, sentCount, repliedCount, queuedCount, replyRate, recentActivity, staleContacts }
      };
    } catch (e) {
      await this.updateStatus('error', objective, `Error: ${e.message}`);
      throw e;
    }
  }
}

// ─── Social Agent ──────────────────────────────────────────────────────────────

class SocialAgent extends Agent {
  constructor() {
    super({
      id: 'social',
      type: 'social',
      name: 'A-Gent Social',
      description: 'Manages social media publishing and engagement tracking',
      capabilities: ['llm.chat', 'supabase.query']
    });
  }

  async execute({ objective, context = {}, taskId }) {
    await this.updateStatus('active', objective, 'Generating social content');

    try {
      const content = await this.use('llm', 'chat', {
        messages: [
          {
            role: 'system',
            content: 'You are A-Gent Social. Generate engaging social media content aligned with the A-Gent brand voice: professional but approachable B2B SaaS.'
          },
          {
            role: 'user',
            content: `Objective: ${objective}\nPlatform: ${context.platform || 'twitter'}\nTopic: ${context.topic || 'AI sales agents'}`
          }
        ],
        temperature: 0.7,
        maxTokens: 300
      });

      await this.remember('note', `Social content for ${context.platform || 'twitter'}: ${content.content}`, {
        platform: context.platform,
        content: content.content
      });

      await this.updateStatus('idle', null, 'Content generated');
      return { success: true, content: content.content };
    } catch (e) {
      await this.updateStatus('error', objective, `Error: ${e.message}`);
      throw e;
    }
  }
}

// ─── Agent Registry ────────────────────────────────────────────────────────────

const _agents = {};
let _registryInitialized = false;

function initAgents() {
  if (_registryInitialized) return;
  initConnectors();
  
  _agents['manager'] = new ManagerAgent();
  _agents['researcher'] = new ResearcherAgent();
  _agents['sdr'] = new SDRAgent();
  _agents['ops'] = new OpsAgent();
  _agents['support'] = new SupportAgent();
  _agents['success'] = new SuccessAgent();
  _agents['social'] = new SocialAgent();
  
  _registryInitialized = true;
}

function getAgent(id) {
  initAgents();
  return _agents[id];
}

function listAgents() {
  initAgents();
  return Object.values(_agents).map(a => ({
    id: a.id,
    type: a.type,
    name: a.name,
    description: a.description,
    status: a.status,
    capabilities: a.capabilities
  }));
}

/**
 * Get all agent statuses from Supabase (or fall back to in-memory)
 */
async function getAgentStatuses() {
  const { url, key } = getSupabaseCreds();
  try {
    const res = await fetch(`${url}/rest/v1/agent_registry?select=agent_id,agent_type,name,description,status,current_task,last_action,last_active_at&order=agent_type.asc`, {
      headers: { 'apikey': key, 'Authorization': `Bearer ${key}` }
    });
    if (res.ok) return await res.json();
  } catch (e) { /* fall through */ }
  
  // Fallback to in-memory
  return listAgents();
}

// ─── Export ────────────────────────────────────────────────────────────────────

export {
  Agent,
  ManagerAgent,
  ResearcherAgent,
  SDRAgent,
  OpsAgent,
  SupportAgent,
  SuccessAgent,
  SocialAgent,
  initAgents,
  getAgent,
  listAgents,
  getAgentStatuses
};
