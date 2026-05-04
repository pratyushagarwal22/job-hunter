# Story Bank — Master STAR+R Stories

This file accumulates your best interview stories over time. Each evaluation (Block F) adds new stories here. Instead of memorizing 100 answers, maintain 5-10 deep stories that you can bend to answer almost any behavioral question.

## How it works

1. Every time `/career-ops oferta` generates Block F (Interview Plan), new STAR+R stories get appended here
2. Before your next interview, review this file — your stories are already organized by theme
3. The "Big Three" questions can be answered with stories from this bank:
   - "Tell me about yourself" → combine 2-3 stories into a narrative
   - "Tell me about your most impactful project" → pick your highest-impact story
   - "Tell me about a conflict you resolved" → find a story with a Reflection

## Stories

### [Impact / Ownership] Fraud Detection Workflow at Apna
**Source:** Seed Story #001 — Apna (Trust and Safety) — Data Analyst
**S (Situation):** Apna's marketplace had a growing fraud problem — recruiters were posting jobs to extract money from candidates, directly hurting the team's north-star metric (Candidate Exposure to Fraudulent Jobs). The existing detection process was reactive, manual, and depended on agents reviewing complaints one at a time.
**T (Task):** As the only data analyst on the Trust and Safety team, I was asked to design a faster, more proactive way to identify and act on fraudulent recruiters before they could harm more candidates.
**A (Action):** I built a SQL-based detection workflow on top of Metabase and Retool that flagged recruiters based on charging-money complaints, document anomalies (PAN/GST/AADHAAR mismatches), and device-level signals. I first ran exploratory analysis to size the impact, then built a temporary version using filter queries to validate internally before partnering with engineering to ship the "Charging Money Complaints Job Pause" feature — auto-pausing a recruiter's jobs after the first credible complaint, with a 3-hour agent SLA to mark fraud / not fraud / inconclusive.
**R (Result):** Reduced fraudulent recruiter activity by ~20% within one month. The Job Pause feature alone improved the north-star metric by 5%. The framework also became the foundation for the proactive workstream the team built afterward.
**Reflection:** I learned that the highest-leverage analytics work isn't the dashboard — it's the workflow change the dashboard justifies. Going forward, I always ask "what decision or action does this data unlock?" before I write the first query.
**Best for questions about:** highest-impact project, ownership, working with ambiguity, data-driven decisions, security/trust, designing systems from scratch

---

### [Cross-Functional Collaboration / Conflict] Database Migration Conflict at Apna
**Source:** Seed Story #002 — Apna (Trust and Safety) — Data Analyst
**S (Situation):** The data engineering team at Apna decided to migrate our databases three times in roughly a year — Postgres → BigQuery → partitioned BigQuery → Presto — to cut infrastructure cost. Each migration broke queries, slowed agent workflows, and introduced new privacy/security restrictions that would have blocked legitimate Trust and Safety investigations. Friction with data engineering was mounting.
**T (Task):** I had to keep my team operational through every migration while also pushing back — without burning the relationship — on changes that would have made fraud investigations impossible.
**A (Action):** Instead of escalating reactively, I synced separately with the Trust and Safety Head, Ops Head, and Ops Managers to gather a single consolidated list of must-have access patterns and use cases. I brought that to data engineering as a structured proposal rather than a list of complaints, which reframed the conversation from "you're blocking us" to "here's what the business needs — let's design around it." In parallel, I migrated dashboards/queries proactively (Postgres → BigQuery → Presto), and learned Presto syntax in roughly a week to keep agents unblocked. I also identified our top 10 highest-cost queries and rewrote them with partition filters and 6-month windows.
**R (Result):** Privacy controls shipped without breaking investigations. Query optimization saved ~$2,500/month and made agent investigations ~20% faster. The data engineering relationship improved from adversarial to collaborative — they started looping me in earlier on schema decisions.
**Reflection:** Conflict at work is almost never about the surface issue. Once I stopped defending my team's tools and started showing the business outcomes at risk, the engineering team had something concrete to design against. I now default to consolidating stakeholder input before any cross-team escalation.
**Best for questions about:** conflict resolution, working with engineering, stakeholder management, dealing with change, learning quickly, cost optimization

---

### [Leadership / Resourcefulness] Scaling a 70k-Entry Review Task at Google
**Source:** Seed Story #003 — Google (Channel Sales Activation) — Strategy and Analytics Intern
**S (Situation):** During my Google internship, after impressing my manager on a small sentiment-analysis validation task, I was given a much bigger one: validate the output of a sentiment-analysis pipeline across ~70,000 review entries. There was no team allocated and no clear timeline.
**T (Task):** Deliver high-quality validated output on a scale that one person could not realistically handle alone, while keeping cost reasonable for the team.
**A (Action):** I broke down the work into a structured task spec, shared a timeline with my manager, and proposed sourcing reviewers through my university's ACM Student Chapter (where I'd previously been Head of Promotions). I onboarded 12 students, created clear quality criteria and a review template, and ran QC on samples before passing batches up to my manager. When mistakes surfaced in their work, I owned them rather than passing blame — that was a quality-control gap on my end. The students were paid a nominal amount for the work, which gave them real experience and let me deliver fast.
**R (Result):** The 70k-entry task was completed well ahead of what a solo timeline would have allowed. My manager extended my engagement by 3 additional months on the back of how the project ran. I later led a separate team of 3 interns on the Brand Prominence pillar.
**Reflection:** Resourcefulness is a skill, not a fluke. I learned that "I don't have the team for this" is a constraint to design around, not an excuse to push back. I also learned to build QC into delegation from day one — not after the first round of mistakes.
**Best for questions about:** leadership without authority, scaling yourself, resourcefulness, taking initiative, owning mistakes, going above and beyond as an intern

---

### [Building Something New] TickerSense — End-to-End AI Product
**Source:** Seed Story #004 — Personal Project (UIUC) — Builder
**S (Situation):** Public-market research is fragmented — SEC filings live on EDGAR, fundamentals on one platform, charts on another, governance disclosures somewhere else. As someone who personally wanted to do faster company research, I was tired of bouncing between five tabs to form a basic view of any ticker.
**T (Task):** Build a single-interface company-intelligence platform that pulls SEC filings (10-K, 10-Q, 8-K), fundamentals, charts, governance disclosures, and an AI assistant into one place — without crossing into investment-advice territory.
**A (Action):** I designed the full stack solo: a Python backend service to ingest, normalize, and enrich filing/market data; a modern web frontend for exploration; SEC EDGAR + market data integrations; AI summaries and source-grounded QandA using the Claude API; PDF export for shareable research reports. I deployed the frontend on Vercel and the backend on Render, and built fallback/demo behavior so the app stays usable while the ingestion service spins up. I made an explicit product decision that the assistant would never give buy/sell recommendations — official filings stay the source of truth.
**R (Result):** Shipped a working product at project-tickersense.vercel.app with public GitHub. Submitted as part of the Anthropic Claude Builder Club Hackathon at UIUC under the "Thinking Partners, Not Replacements" theme — placed 2nd. Used live by classmates and shared on LinkedIn.
**Reflection:** Constraints make products. Deciding up front that the assistant would not recommend trades forced cleaner UX and made every other design decision easier. Also: full-stack solo work taught me what each layer actually costs to maintain — useful context I bring back to my data-engineering work.
**Best for questions about:** most impactful project (technical), building 0→1, AI/LLM applications, product thinking, full-stack ability, going beyond the job description

---

### [Stakeholder Management / Pushing Through Blockers] Pipeline Bug, Furious Manager Call
**Source:** Seed Story #005 — Apna (Trust and Safety) — Data Analyst
**S (Situation):** A candidate at Apna had been duped by a fraudulent recruiter and filed a formal complaint that escalated to law enforcement. HR needed accurate platform data to share with the police, urgently. My manager messaged me on Slack — I missed the messages, and by the time I picked up his call he was furious. Another analyst had tried to pull the data and gotten it wrong because they didn't know the systems.
**T (Task):** Get accurate, defensible data ready for HR and the police as fast as humanly possible — under pressure, after letting the team down on availability, and knowing the data would be used in a legal context.
**A (Action):** I started my laptop immediately, didn't get defensive on the call, and went straight to executing. I pulled the recruiter's full activity history, candidate interaction logs, and the relevant fraud signals — using the consolidated query infrastructure I'd already built for the team — and cross-checked outputs before sharing anything. Within 30 minutes I had a full, audit-trail-quality dataset ready to hand over. After the incident I set up a separate, stricter notification channel for time-critical Trust and Safety asks so a missed Slack message could never block a legal escalation again.
**R (Result):** HR got the data in time to hand to the police. The investigation moved forward without the platform looking unprepared. My manager and I were good after — what could have been a damaging moment became a trust-builder because the recovery was clean.
**Reflection:** Two lessons. One: when you've messed up, the fastest way out is execution, not explanation — apologies land better after the work is done. Two: any process that depends on me being online in real time is a process that will fail eventually. Build the alerting around the criticality of the request, not your own habits.
**Best for questions about:** working under pressure, dealing with mistakes, recovering from failure, handling angry stakeholders, ownership, time-critical work

---

### [Process Improvement / Efficiency] Unifying Reactive + Proactive Workstreams at Apna
**Source:** Seed Story #006 — Apna (Trust and Safety) — Data Analyst
**S (Situation):** Apna's Trust and Safety team had been running two separate fraud-investigation workstreams — reactive (complaint-driven) and proactive (signal-driven) — staffed by different agents with separate dashboards. The same recruiter could be flagged in both, sometimes multiple times, and agents were duplicating investigations without realizing it.
**T (Task):** Eliminate the redundant work without losing investigation coverage, and design a system that would scale as more workstreams got added.
**A (Action):** I built a single SQL-driven tracking system in BigQuery + Metabase that linked recruiters across both workstreams, with priority flags per category. I designed bucket-based routing rules: if a recruiter was flagged for a specific workstream first, they were investigated under that bucket and any duplicate tickets attached to the same investigation. I also built decision rules for the three outcomes — fraud (ban + auto-resolve all linked tickets), not fraud (resolve + 6-month suppression from queries), inconclusive (next flag routes to the same agent who already has context). I partnered with engineering to add tracking tags so the routing was visible in the agent UI.
**R (Result):** Reduced duplicate investigations by ~35% and saved 20+ agent hours weekly. Investigation coverage actually went up because routing got better — agents stopped re-doing each other's work and started building context-rich case files.
**Reflection:** "Two teams doing the same work with different tools" is one of the most common problems in growing organizations, and it almost never gets fixed by one team unilaterally. The unlock here was modeling the system around the recruiter (the entity), not around the workstream (the org chart) — that reframing made the consolidation obvious.
**Best for questions about:** process improvement, eliminating waste, designing systems, working across teams, efficiency wins, thinking from first principles

---

### [Ramping Up Quickly / Adaptability] First Week as Solo Analyst at a Startup
**Source:** Seed Story #007 — Apna (Trust and Safety) — Data Analyst
**S (Situation):** I joined Apna in October 2022 as the only data analyst on the Trust and Safety team. There was no formal onboarding plan, no documentation, no handover — the previous analyst had moved on, and the team needed contributions immediately because fraud investigations were already backed up.
**T (Task):** Get productive in roughly one week, on unfamiliar tools (Metabase, Mixpanel, BigQuery), unfamiliar domain (recruiter fraud patterns), and an unfamiliar tech stack — while not breaking anything in production.
**A (Action):** I prioritized depth over breadth: spent the first 2 days reading every saved query and dashboard the previous analyst had left behind, mapping them to the team's actual investigation flows by sitting with Ops agents on calls. Days 3-4 I rebuilt the most-used queries from scratch in my own style so I'd actually understand the joins. Day 5 I picked one small, low-risk, high-value request from the Ops Manager (a candidate-complaint filter) and shipped it end-to-end. I took notes on every undocumented system quirk and turned them into the team's first internal Notion knowledge base.
**R (Result):** Shipped my first investigation-supporting query by end of week 1. Within a month I was the team's go-to for ad-hoc analysis. The Notion knowledge base I started became standard onboarding material for future hires across the Trust and Safety org.
**Reflection:** Steep ramp-ups reward humility, not heroics. The fastest path was watching how Ops agents actually used the data, not reading documentation that didn't exist. I now treat "shadow the user before you build" as a default, not a luxury.
**Best for questions about:** ramping up quickly, adaptability, working with ambiguity, learning new tools, joining a startup, self-direction

---

### [Cross-Functional Leadership Under Constraints] Quantum Satellite Game Delivery
**Source:** Seed Story #008 — the stu/dio at Illinois — Project Manager
**S (Situation):** I led the stu/dio team building Quantum Satellite, a high-priority quantum-themed game built in collaboration with NASA to gather user input for random-number generation research. The project had a hard mid-December to end-of-February delivery window, sponsors who wanted regular visibility, and a team of student programmers, designers, and artists with mismatched availability and class schedules.
**T (Task):** Deliver a polished game on time, on a tight budget, with student resources — as a student PM myself, on my first game-development project.
**A (Action):** I implemented an Agile workflow to track milestones, tasks, bugs, and dependencies. I built the prioritization framework with the programming lead by reviewing the game design doc together, breaking work into tasks with two parameters — core-mechanic priority and implementation difficulty — and pushing high-priority + high-difficulty items to the front so they couldn't slip late. I used the senior producer as a sanity check on planning decisions rather than trying to reinvent game-dev project management. When a key programmer became unavailable for 3 weeks mid-project, I rebalanced the backlog around remaining capacity, shifted independent art/design tasks forward, and protected the critical path. I kept sponsors looped in with regular updates so the temporary capacity loss didn't surprise anyone.
**R (Result):** Shipped the game in 2 months, ~$2,000 under budget, with all critical features intact. Post-launch I managed maintenance and optimization of a 20,000+ downloads game — resolving bugs, improving stability, and adapting it for broader global use.
**Reflection:** "On-track despite a 3-week absence" only works if your plan was never dependent on a single person being there every week. After this project I stopped building schedules around best-case capacity and started building around realistic capacity with named slack — so the inevitable absence is absorbed instead of escalated.
**Best for questions about:** project management, leading peers, dealing with resource loss, cross-functional coordination, prioritization, hitting deadlines, managing stakeholders

---

### [Identifying Opportunities / Strategic Thinking] Brand Prominence Pillar at Google
**Source:** Seed Story #009 — Google (Channel Sales Activation) — Strategy and Analytics Intern
**S (Situation):** The Channel Sales Activation team at Google was tracking three pillars of market data — sales, delivery timelines, and reviews — to inform strategy for the Pixel and Devices product lines. After a couple of months on the team, I noticed the data we were producing wasn't fully answering the team's actual question: where Google products were winning consumer attention versus where competitors were dominating retailer real estate.
**T (Task):** This wasn't asked of me — I had to decide whether to flag it, propose something, or stay in scope.
**A (Action):** I proposed a fourth pillar: Brand Prominence — measuring how much space competing brands occupied on retailer home pages and what kinds of deals they were running. I made the case to my manager: most consumers form their promotion awareness from retailer landing pages, so this signal was directly upstream of share-of-mind. After approval, I led a team of 3 interns to build it: I created a database of retailer URLs across regions, wrote scripts using ChromeDriver + Selenium + WebArchive to capture historical and current snapshots, and structured the output so it could feed Looker Studio dashboards alongside the existing pillars.
**R (Result):** Brand Prominence became a permanent pillar in the team's market intelligence stack, feeding into bi-weekly executive reports across US, UK, Germany, and APAC. The framework was reused when the team expanded coverage to Google Nest products. My manager extended my engagement specifically because of work like this.
**Reflection:** "What you're tracking" and "what would actually answer the strategic question" are two different things, and the gap between them is usually where interns add the most value — because they haven't internalized the existing measurement framework yet. I try to keep that fresh-eyes habit even on long-running projects.
**Best for questions about:** strategic thinking, going beyond your scope, identifying opportunities, leading peers, executive-level communication, building from scratch

<!-- New stories will be appended below this line as you evaluate offers -->
<!-- Format:
### [Theme] Story Title
**Source:** Report #NNN — Company — Role
**S (Situation):** ...
**T (Task):** ...
**A (Action):** ...
**R (Result):** ...
**Reflection:** What I learned / what I'd do differently
**Best for questions about:** [list of question types this story answers]
-->