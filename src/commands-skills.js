'use strict';
const { esc, clampCard } = require('./formatter');
const { card, kv, kb, btn, wrapBtn, menuExitRow } = require('./ui');
const { cardReply } = require('./card-session');
const { listSkills, readSkill, createSkill, deleteSkill, readHook, writeHook, clearHook, findSkillMentions, SKILL_NAME_RE } = require('./skills');

// /skill manages markdown skill files; /hook reads/edits the agent hook.
// The hook is loaded once by index.js into the CliRunner, so edits reply with
// a hint that the runner copy refreshes on restart.
function registerSkillCommands(bot, { cfg, registry }) {
  const skillsDir = () => cfg.paths?.skills ?? './data/skills';
  const chatIdOf = ctx => ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id || 0;

  const showSkills = ctx => {
    const skills = listSkills(skillsDir());
    const rows = skills.map(s => [btn(`📄 ${esc(s.name)} — ${esc(s.description || '(no description)')}`, `skill:view:${s.name}`)]);
    const body = card({
      icon: '🧩',
      title: 'Skills',
      meta: 'markdown guidance files the agent can read',
      rows: [
        skills.length ? `${skills.length} skill(s) in <code>${esc(skillsDir())}</code>:` : 'No skills yet — add your first .md skill below.',
        '<i>Tap a skill to view/edit it, or type <code>@skillname.md</code> in chat to list skills.</i>',
      ],
    });
    return cardReply(ctx, ctx.cards, body, {
      parse_mode: 'HTML',
      reply_markup: kb(...wrapBtn([btn('➕ Add skill', 'skill:add'), btn('🏠 Menu', 'cmd:help')], 2), ...rows),
    });
  };

  const showSkill = (ctx, name) => {
    const content = readSkill(skillsDir(), name);
    if (content == null) return showSkills(ctx);
    const body = card({
      icon: '🧩',
      title: `Skill: ${esc(name)}`,
      rows: [content.slice(0, 3500)],
      footer: '<i>Tap Edit to replace the content with your next message.</i>',
    });
    return cardReply(ctx, ctx.cards, clampCard(body), {
      parse_mode: 'HTML',
      reply_markup: kb(
        [btn('📝 Edit', `skill:edit:${name}`), btn('🗑 Delete', `skill:del:${name}`)],
        [btn('⬅️ All skills', 'cmd:skill'), btn('🏠 Menu', 'cmd:help')],
      ),
    });
  };

  bot.action('cmd:skill', async ctx => { await ctx.answerCbQuery(); return showSkills(ctx); });
  bot.action('settings:skills', async ctx => { await ctx.answerCbQuery(); return showSkills(ctx); });

  bot.action(/^skill:view:([\w-]+)$/, async ctx => {
    await ctx.answerCbQuery();
    return showSkill(ctx, ctx.match[1]);
  });

  bot.action('skill:add', async ctx => {
    await ctx.answerCbQuery();
    registry.pendingInput = {
      type: 'skillName',
      chatId: chatIdOf(ctx),
      handler: (inputCtx, text) => {
        const name = text.trim().replace(/\.md$/i, '');
        if (!SKILL_NAME_RE.test(name)) {
          return cardReply(inputCtx, inputCtx.cards, '⚠️ Invalid name — use letters, digits, <code>-</code> or <code>_</code> only. Send the name again or tap below:', { parse_mode: 'HTML', reply_markup: kb(...menuExitRow()) });
        }
        registry.pendingInput = {
          type: 'skillContent',
          chatId: chatIdOf(inputCtx),
          skillName: name,
          handler: (contentCtx, body) => {
            createSkill(skillsDir(), name, body);
            return cardReply(contentCtx, contentCtx.cards, card({
              icon: '✅', title: 'Skill created',
              rows: [kv('🧩 Name', esc(name)), kv('📂 Path', `<code>${esc(skillsDir())}</code>`)],
            }), { parse_mode: 'HTML', reply_markup: kb([btn('🧩 View skills', 'cmd:skill'), btn('🏠 Menu', 'cmd:help')]) });
          },
        };
        return cardReply(inputCtx, inputCtx.cards, card({
          icon: '📝', title: `Skill body for ${esc(name)}`,
          rows: ['Send the markdown content in your next message (one message).'],
        }), { parse_mode: 'HTML', reply_markup: kb(...menuExitRow()) });
      },
    };
    return cardReply(ctx, ctx.cards, card({
      icon: '➕', title: 'Add Skill',
      rows: ['Send the skill NAME in your next message (e.g. <code>code-review</code>).'],
    }), { parse_mode: 'HTML', reply_markup: kb(...menuExitRow()) });
  });

  bot.action(/^skill:edit:([\w-]+)$/, async ctx => {
    await ctx.answerCbQuery();
    const name = ctx.match[1];
    registry.pendingInput = {
      type: 'skillContent',
      chatId: chatIdOf(ctx),
      skillName: name,
      handler: (contentCtx, body) => {
        createSkill(skillsDir(), name, body);
        return cardReply(contentCtx, contentCtx.cards, card({
          icon: '✅', title: 'Skill updated',
          rows: [kv('🧩 Name', esc(name))],
        }), { parse_mode: 'HTML', reply_markup: kb([btn('🧩 View skills', 'cmd:skill'), btn('🏠 Menu', 'cmd:help')]) });
      },
    };
    return cardReply(ctx, ctx.cards, card({
      icon: '📝', title: `Edit ${esc(name)}`,
      rows: ['Send the FULL replacement markdown in your next message.'],
    }), { parse_mode: 'HTML', reply_markup: kb(...menuExitRow()) });
  });

  bot.action(/^skill:del:([\w-]+)$/, async ctx => {
    await ctx.answerCbQuery();
    const name = ctx.match[1];
    return cardReply(ctx, ctx.cards, card({
      icon: '🗑', title: `Delete ${esc(name)}?`,
      rows: ['This removes the .md file from disk.'],
    }), {
      parse_mode: 'HTML',
      reply_markup: kb([btn('✅ Delete for real', `skill:del_confirm:${name}`), btn('⬅️ Keep it', 'cmd:skill')]),
    });
  });

  bot.action(/^skill:del_confirm:([\w-]+)$/, async ctx => {
    await ctx.answerCbQuery();
    const name = ctx.match[1];
    const gone = deleteSkill(skillsDir(), name);
    return cardReply(ctx, ctx.cards, card({
      icon: gone ? '🗑' : '⚠️',
      title: gone ? 'Skill deleted' : 'Skill not found',
      rows: [gone ? `<code>${esc(name)}</code> removed.` : `<code>${esc(name)}</code> was already gone.`],
    }), { parse_mode: 'HTML', reply_markup: kb([btn('🧩 View skills', 'cmd:skill'), btn('🏠 Menu', 'cmd:help')]) });
  });

  // ── /hook ────────────────────────────────────────────────────────────────
  const showHook = ctx => {
    const hook = readHook(skillsDir());
    const body = card({
      icon: '🪝',
      title: 'Agent Hook',
      rows: [
        hook ? hook.slice(0, 3500) : '(no hook yet)',
        '',
        '<i>The hook is prepended to every task prompt as standing rules.</i>',
      ],
      footer: '<i>Edits apply to newly spawned agents; restart TAO to reload the runner copy.</i>',
    });
    return cardReply(ctx, ctx.cards, clampCard(body), {
      parse_mode: 'HTML',
      reply_markup: kb(
        [btn('📝 Edit hook', 'hook:edit'), ...(hook ? [btn('🗑 Clear hook', 'hook:clear')] : [])],
        [btn('🏠 Menu', 'cmd:help')],
      ),
    });
  };

  bot.action('cmd:hook', async ctx => { await ctx.answerCbQuery(); return showHook(ctx); });
  bot.action('settings:hook', async ctx => { await ctx.answerCbQuery(); return showHook(ctx); });

  bot.action('hook:edit', async ctx => {
    await ctx.answerCbQuery();
    registry.pendingInput = {
      type: 'hook',
      chatId: chatIdOf(ctx),
      handler: (inputCtx, text) => {
        writeHook(skillsDir(), text);
        return cardReply(inputCtx, inputCtx.cards, card({
          icon: '✅', title: 'Hook saved',
          rows: ['The hook will be injected into every new task prompt.', '<i>Restart TAO to refresh the runner\'s in-memory copy.</i>'],
        }), { parse_mode: 'HTML', reply_markup: kb([btn('🪝 View hook', 'cmd:hook'), btn('🏠 Menu', 'cmd:help')]) });
      },
    };
    return cardReply(ctx, ctx.cards, card({
      icon: '📝', title: 'Edit hook',
      rows: ['Send the hook text in your next message — it replaces the current hook.'],
    }), { parse_mode: 'HTML', reply_markup: kb(...menuExitRow()) });
  });

  bot.action('hook:clear', async ctx => {
    await ctx.answerCbQuery();
    clearHook(skillsDir());
    return cardReply(ctx, ctx.cards, card({
      icon: '🪝', title: 'Hook cleared',
      rows: ['No hook is injected anymore.'],
    }), { parse_mode: 'HTML', reply_markup: kb([btn('🪝 View hook', 'cmd:hook'), btn('🏠 Menu', 'cmd:help')]) });
  });
}

// Mention entry point wired into bot.js's text handler BEFORE follow-up/compose.
// Renders the skills card; highlights the queried skill when it exists.
async function handleSkillMention(ctx, text, cfg) {
  // A skill mention requires "@"; skip the skills-dir disk scan for every
  // other message (this runs on ALL text before follow-up/compose handling).
  if (!/@/.test(text)) return false;
  const dir = cfg?.paths?.skills ?? './data/skills';
  const skills = listSkills(dir);
  const mentioned = findSkillMentions(text, skills.map(s => s.name));
  if (mentioned.length === 0 && !/@[\w-]+\.md\b/i.test(text)) return false;
  const body = card({
    icon: '🧩',
    title: 'Skills',
    meta: mentioned.length ? `skill(s) mentioned: ${esc(mentioned.join(', '))}` : 'available skills',
    rows: skills.length
      ? skills.map(s => `${mentioned.includes(s.name.toLowerCase()) ? '👉 ' : ''}` + kv(s.name, esc(s.description || '(no description)')))
      : ['No skills yet — tap Add below.'],
  });
  await cardReply(ctx, ctx.cards, body, {
    parse_mode: 'HTML',
    reply_markup: kb(...wrapBtn([btn('🧩 All skills', 'cmd:skill'), btn('➕ Add skill', 'skill:add'), btn('🏠 Menu', 'cmd:help')], 2)),
  });
  return true;
}

module.exports = { registerSkillCommands, handleSkillMention };
