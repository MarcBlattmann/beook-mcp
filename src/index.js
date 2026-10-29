#!/usr/bin/env node
// MCP server for the beook desktop app (hep / ionesoft ebooks).
// It reads exercises from the running app through Chromium's remote debugging port and writes
// answers back into the same fields a user would type into; beook then saves and syncs them itself.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DEBUG_PORT, isDebugPortUp, listPageTargets, withSession } from './cdp.js';
import { findExercise, listBooks, listExercises, mostRecentlyOpened, neighbourExercise } from './db.js';
import { isBeookRunning, launchBeook } from './launch.js';
import { pageCall } from './page.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastViewId = null;

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (err) => ({ content: [{ type: 'text', text: `Error: ${err.message || err}` }], isError: true });
const tool = (handler) => async (args) => {
  try {
    return await handler(args);
  } catch (err) {
    return fail(err);
  }
};

async function ensureConnected() {
  if (await isDebugPortUp()) return;
  throw new Error(
    isBeookRunning()
      ? 'beook is running without the debug connection. Call beook_launch with restart=true first.'
      : 'beook is not running. Call beook_launch first.',
  );
}

// All beook content views (exercise pages, book pages, ...), with a quick description of each.
async function getViews() {
  await ensureConnected();
  const targets = (await listPageTargets()).filter((t) => t.url.includes('localhost:7212/__text__'));
  const views = await Promise.all(
    targets.map(async (target) => {
      try {
        return { target, ...(await withSession(target, (s) => s.evaluate(pageCall('probe'), 5000))) };
      } catch {
        return null;
      }
    }),
  );
  return views.filter(Boolean);
}

// beook keeps one exercise view per opened book, so several can be open at once.
// With a ref we only ever use the view showing exactly that exercise.
async function pickExerciseView({ ref, course } = {}) {
  const views = (await getViews()).filter((v) => v.isExercise && (!course || v.course === course));
  if (ref) {
    const view = views.find((v) => v.ref === ref);
    if (!view) {
      const open = views.map((v) => `${v.course} ${v.ref}`).join(', ') || 'none';
      throw new Error(`Exercise ${ref} is not open in beook (open: ${open}). Use beook_open_exercise first.`);
    }
    lastViewId = view.target.id;
    return view;
  }
  if (views.length === 0) {
    throw new Error(
      `No exercise is open in beook${course ? ` for ${course}` : ''}. Use beook_open_exercise (or open a book in beook once).`,
    );
  }
  const recentRef = mostRecentlyOpened(views.map((v) => v.ref).filter(Boolean));
  const view =
    views.find((v) => v.target.id === lastViewId) || views.find((v) => v.ref && v.ref === recentRef) || views[0];
  lastViewId = view.target.id;
  return view;
}

// Opens an exercise by clicking a link inside a beook content view. Not every view handles these
// links (and the portal / annotation board would load the URL themselves), so try content views in turn.
async function openExercise(ex) {
  const url =
    `http://localhost:7212/exercises/type/1/course/${encodeURIComponent(ex.courseId)}` +
    `/courseReference/${encodeURIComponent(ex.courseReference)}/issueId/${encodeURIComponent(ex.chapterId)}` +
    `/exerciseReferences/${encodeURIComponent(ex.ref)}`;
  const isTarget = (v) => v.isExercise && v.course === ex.courseId && v.ref === ex.ref;
  const views = (await getViews()).filter((v) => v.course);
  const already = views.find(isTarget);
  if (already) return already;
  const candidates = [
    ...views.filter((v) => v.isExercise && v.course === ex.courseId),
    ...views.filter((v) => v.isExercise && v.course !== ex.courseId),
    ...views.filter((v) => !v.isExercise),
  ];
  if (candidates.length === 0) {
    throw new Error('Open any book page or exercise in beook once (click a book on the left), then try again.');
  }
  for (const from of candidates) {
    await withSession(from.target, (s) => s.evaluate(pageCall('navigate', url)));
    const view = await waitForView(isTarget, 6000);
    if (view) return view;
  }
  throw new Error(`beook did not open ${ex.ref}. Is the book downloaded in beook?`);
}

function formatExercise(ex) {
  const lines = [
    `Book: ${ex.course || '?'} | Exercise: ${ex.ref || '?'} | ${ex.heading || ''}`,
    `Type: ${ex.exerciseType || 'unknown'}`,
    '',
    ex.text,
    '',
  ];
  if (ex.fields.length === 0) {
    lines.push('No answer fields on this page.');
  } else {
    lines.push('Fields (fill with beook_fill_answers):');
    for (const f of ex.fields) {
      switch (f.kind) {
        case 'text':
          lines.push(`- ${f.id} text, current: "${f.value}"`);
          break;
        case 'single_choice':
        case 'multiple_choice':
          lines.push(
            `- ${f.id} ${f.kind}: ${f.options.map((o) => `${o.id} "${o.label}"${o.checked ? ' [x]' : ''}`).join(', ')}`,
          );
          break;
        case 'select':
          lines.push(`- ${f.id} select: ${f.options.join(' | ')} (current "${f.value}")`);
          break;
        case 'dropzone':
          lines.push(`- ${f.id} drop zone${f.max ? ` (max ${f.max})` : ''}, current: ${JSON.stringify(f.value)}`);
          break;
        case 'order':
          lines.push(`- ${f.id} order list: give all items in the right order`);
          break;
        default:
          lines.push(`- ${f.id} ${f.kind}: not fillable by text (use beook_screenshot + beook_click)`);
      }
    }
  }
  if (ex.pool.length) {
    lines.push(`Answer pool: ${ex.pool.map((p) => `${p.id} "${p.text}"${p.reusable ? ' (reusable)' : ''}`).join(', ')}`);
  }
  return lines.join('\n');
}

async function readExercise(view) {
  return withSession(view.target, (s) => s.evaluate(pageCall('describe'), 10000));
}

async function waitForView(predicate, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await sleep(700);
    const match = (await getViews()).find(predicate);
    if (match) return match;
  }
  return null;
}

const server = new McpServer(
  { name: 'beook', version: '0.1.0' },
  {
    instructions: [
      'Tools for the beook ebook app (Swiss school textbooks and workbooks by hep).',
      'Typical flow: beook_status -> (beook_launch) -> beook_list_exercises -> beook_open_exercise -> work out the answers yourself from the exercise text -> beook_fill_answers with the same ref -> check the returned state.',
      'Exercise text marks every answer field inline as ⟦F1 ...⟧; options are F1.1, F1.2; answer-pool items are P1, P2.',
      'Answers are written into the real app and saved to the user\'s account, so only fill what the user asked for and tell them what you entered.',
      'Drawing and arrow exercises cannot be filled by text: use beook_screenshot and beook_click.',
    ].join('\n'),
  },
);

server.registerTool(
  'beook_status',
  {
    title: 'beook status',
    description: 'Check whether beook is running and reachable, and which books/exercises are currently open.',
    inputSchema: {},
  },
  tool(async () => {
    const running = isBeookRunning();
    const connected = await isDebugPortUp();
    const lines = [`beook running: ${running}`, `debug connection (port ${DEBUG_PORT}): ${connected}`];
    if (!connected) {
      lines.push(running ? 'Call beook_launch with restart=true to enable the connection.' : 'Call beook_launch to start beook.');
      return text(lines.join('\n'));
    }
    const views = await getViews();
    const exercises = views.filter((v) => v.isExercise);
    lines.push(
      exercises.length
        ? `Open exercises:\n${exercises.map((v) => `- ${v.course}: ${v.ref || '?'} ${v.heading || ''}`).join('\n')}`
        : 'No exercise open right now.',
    );
    return text(lines.join('\n'));
  }),
);

server.registerTool(
  'beook_launch',
  {
    title: 'Start beook',
    description:
      'Start beook with the debug connection this server needs. If beook is already running without it, pass restart=true to close it normally and reopen it.',
    inputSchema: { restart: z.boolean().optional().describe('Close a running beook and reopen it') },
  },
  tool(async ({ restart }) => text(await launchBeook({ restart }))),
);

server.registerTool(
  'beook_list_books',
  {
    title: 'List books',
    description: 'List the books (courses) in beook with their chapters and how many exercises are done.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  tool(async () => {
    const lines = [];
    for (const book of listBooks()) {
      lines.push(`${book.courseId}: ${book.title}`);
      for (const ch of book.chapters) {
        lines.push(`  ${ch.chapterId}  ${ch.title}${ch.exercises ? `  (${ch.done}/${ch.exercises} exercises done)` : ''}`);
      }
    }
    return text(lines.join('\n'));
  }),
);

server.registerTool(
  'beook_list_exercises',
  {
    title: 'List exercises',
    description: 'List exercises with their reference (needed for beook_open_exercise), number, title and done state.',
    inputSchema: {
      course: z.string().optional().describe('Book id, e.g. GESZHAH'),
      chapter: z.string().optional().describe('Chapter id, e.g. GESZHAH02'),
      only_open: z.boolean().optional().describe('Only exercises not marked as done'),
    },
    annotations: { readOnlyHint: true },
  },
  tool(async ({ course, chapter, only_open }) => {
    const rows = listExercises({ course, chapter, onlyOpen: only_open });
    if (rows.length === 0) return text('No exercises found.');
    let current = null;
    const lines = [];
    for (const r of rows.slice(0, 400)) {
      const key = `${r.courseId} ${r.chapterId}`;
      if (key !== current) {
        current = key;
        lines.push(`${r.courseId} / ${r.chapterId} ${r.chapterTitle}`);
      }
      lines.push(`  ${r.ref}  ${r.number}  ${r.title || ''}${r.done ? '  [done]' : ''}`);
    }
    if (rows.length > 400) lines.push(`... ${rows.length - 400} more, filter by course or chapter.`);
    return text(lines.join('\n'));
  }),
);

server.registerTool(
  'beook_open_exercise',
  {
    title: 'Open exercise',
    description:
      'Open an exercise in beook by its reference (from beook_list_exercises), or go to the next/previous exercise. Returns the exercise content.',
    inputSchema: {
      ref: z.string().optional().describe('Exercise reference, e.g. EX_02_A4'),
      course: z.string().optional().describe('Book id, only needed if the reference is ambiguous'),
      direction: z
        .enum(['next', 'previous'])
        .optional()
        .describe('Go to the next/previous exercise of the book, starting from ref (or from the open exercise)'),
    },
  },
  tool(async ({ ref, course, direction }) => {
    if (!ref && !direction) throw new Error('Pass either ref or direction.');
    let target;
    if (direction) {
      const from = ref ? findExercise(ref, course) : await pickExerciseView({ course });
      if (!from.ref) throw new Error('Cannot tell which exercise is open; pass ref.');
      target = neighbourExercise(from.ref, from.courseId || from.course, direction);
    } else {
      target = findExercise(ref, course);
    }
    const view = await openExercise(target);
    lastViewId = view.target.id;
    return text(formatExercise(await readExercise(view)));
  }),
);

server.registerTool(
  'beook_read_exercise',
  {
    title: 'Read exercise',
    description:
      'Read the exercise currently open in beook: instructions, inline answer fields with their current values, and the answer pool.',
    inputSchema: {
      ref: z.string().optional().describe('Exercise reference; default: the exercise opened last'),
      course: z.string().optional().describe('Book id, if exercises of several books are open'),
    },
    annotations: { readOnlyHint: true },
  },
  tool(async ({ ref, course }) => text(formatExercise(await readExercise(await pickExerciseView({ ref, course }))))),
);

const answerValue = z.union([z.string(), z.array(z.string()), z.boolean()]);

server.registerTool(
  'beook_fill_answers',
  {
    title: 'Fill answers',
    description: [
      'Write answers into the open exercise; beook saves them like typed input. Values per field kind:',
      'text: the text (use \\n for line breaks).',
      'single_choice: the option label or handle ("F2.3"). multiple_choice: list of all options that should be ticked (others get unticked); or field "F2.3" with true/false.',
      'select: the option text. dropzone: pool item text or handle ("P4"), or a list for zones taking several; [] empties it.',
      'order: list of all items (text or current handle like "F5.2") in the correct order.',
    ].join('\n'),
    inputSchema: {
      ref: z.string().describe('Reference of the exercise these answers belong to (as returned by beook_read_exercise)'),
      answers: z
        .array(z.object({ field: z.string().describe('Field handle, e.g. F1 or F2.3'), value: answerValue }))
        .min(1),
    },
  },
  tool(async ({ ref, answers }) => {
    const view = await pickExerciseView({ ref });
    const { results, stored } = await withSession(view.target, (s) => s.evaluate(pageCall('fill', answers, ref), 20000));
    await sleep(500);
    const after = await readExercise(view);
    const failed = results.filter((r) => !r.ok);
    const summary = [
      `Filled ${results.length - failed.length}/${results.length} fields${stored ? ', saved' : ' (save trigger not found; switching exercise saves too)'}.`,
      ...failed.map((r) => `- ${r.field}: ${r.error}`),
      '',
      'Current state:',
      formatExercise(after),
    ];
    return { ...text(summary.join('\n')), isError: failed.length === results.length };
  }),
);

server.registerTool(
  'beook_screenshot',
  {
    title: 'Screenshot exercise',
    description:
      'Take a screenshot of the open exercise page. Image pixels equal page coordinates, so they can be passed to beook_click.',
    inputSchema: { ref: z.string().optional().describe('Exercise reference; default: the exercise opened last') },
    annotations: { readOnlyHint: true },
  },
  tool(async ({ ref }) => {
    const view = await pickExerciseView({ ref });
    const data = await withSession(view.target, async (s) => {
      const dpr = (await s.evaluate('window.devicePixelRatio')) || 1;
      const metrics = await s.send('Page.getLayoutMetrics');
      const size = metrics.cssContentSize || metrics.contentSize;
      const clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.min(Math.ceil(size.height), 6000), scale: 1 / dpr };
      const shot = await s.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true }, 30000);
      return shot.data;
    });
    return {
      content: [
        { type: 'image', data, mimeType: 'image/png' },
        { type: 'text', text: `${view.course} ${view.ref || ''} ${view.heading || ''}` },
      ],
    };
  }),
);

server.registerTool(
  'beook_click',
  {
    title: 'Click in exercise',
    description:
      'Click (or drag) at page coordinates taken from beook_screenshot. For drawing, arrow and image exercises. Take a new screenshot afterwards to check.',
    inputSchema: {
      x: z.number(),
      y: z.number(),
      drag_to_x: z.number().optional(),
      drag_to_y: z.number().optional(),
      ref: z.string().describe('Reference of the exercise to click in'),
    },
  },
  tool(async ({ x, y, drag_to_x, drag_to_y, ref }) => {
    const view = await pickExerciseView({ ref });
    await withSession(view.target, async (s) => {
      const { scrollX, scrollY } = await s.evaluate(pageCall('scrollToY', y));
      const mouse = (type, px, py, buttons) =>
        s.send('Input.dispatchMouseEvent', {
          type,
          x: px - scrollX,
          y: py - scrollY,
          button: 'left',
          buttons,
          clickCount: 1,
        });
      await mouse('mouseMoved', x, y, 0);
      await mouse('mousePressed', x, y, 1);
      if (drag_to_x !== undefined && drag_to_y !== undefined) {
        for (let i = 1; i <= 10; i++) {
          await mouse('mouseMoved', x + ((drag_to_x - x) * i) / 10, y + ((drag_to_y - y) * i) / 10, 1);
          await sleep(20);
        }
        await mouse('mouseReleased', drag_to_x, drag_to_y, 0);
      } else {
        await mouse('mouseReleased', x, y, 0);
      }
      await s.evaluate(pageCall('store'));
    });
    return text('Done. Take a beook_screenshot to check the result.');
  }),
);

await server.connect(new StdioServerTransport());
