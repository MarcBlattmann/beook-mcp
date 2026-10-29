// Read-only access to beook's local SQLite database (book structure and exercise list).
// Question/answer texts in the DB are encrypted by the publisher; we only use the plain metadata
// and read the actual exercise content from the running app instead.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const WORKSPACE_DIR =
  process.env.BEOOK_WORKSPACE || path.join(process.env.APPDATA || '', 'ionesoft', 'beook', 'release');

function databasePath() {
  let profileId = '1';
  try {
    const ws = JSON.parse(fs.readFileSync(path.join(WORKSPACE_DIR, '.workspace.json'), 'utf8'));
    profileId = ws.workspace?.currentProfileId || profileId;
  } catch {
    // fall back to profile 1
  }
  const file = path.join(WORKSPACE_DIR, 'profiles', String(profileId), 'data', 'beook_book_v6.sqlite');
  if (!fs.existsSync(file)) throw new Error(`beook database not found at ${file}`);
  return file;
}

function query(sql, params = []) {
  const db = new DatabaseSync(databasePath(), { readOnly: true });
  try {
    return db.prepare(sql).all(...params).map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

export function listBooks() {
  const courses = query(`
    SELECT c.Z_PK pk, c.ZCOURSEID courseId, c.ZREFERENCE courseReference,
           COALESCE(e.ZTITLE, s.ZTITLE, p.ZSUBTITLE, c.ZCOURSEID) title
    FROM ZILPCOURSEDEF c
    LEFT JOIN ZILPCOURSEPRODUCT p ON p.Z_PK = c.ZILPCOURSEPRODUCT
    LEFT JOIN ZILPEPRODUCT e ON e.Z_PK = p.ZEPRODUCT
    LEFT JOIN ZILPCOURSESERIES s ON s.Z_PK = p.ZCOURSESERIES
    ORDER BY c.ZTABORDER`);
  const chapters = query(`
    SELECT i.ZCOURSE coursePk, i.ZISSUEID chapterId, i.ZTITLE title,
           COUNT(x.Z_PK) exercises, SUM(CASE WHEN x.ZPROCESSED = 1 THEN 1 ELSE 0 END) done
    FROM ZILPISSUEDEF i
    LEFT JOIN ZILPEXERCISE x ON x.ZISSUE = i.Z_PK
    GROUP BY i.Z_PK
    ORDER BY i.ZORDER`);
  return courses.map(({ pk, ...course }) => ({
    ...course,
    chapters: chapters
      .filter((ch) => ch.coursePk === pk)
      .map(({ coursePk, ...ch }) => ({ ...ch, done: ch.done || 0 })),
  }));
}

const EXERCISE_SELECT = `
  SELECT x.ZREFERENCE ref, x.ZEXERCISEID number, x.ZTITLE title, x.ZPROCESSED processed,
         i.ZISSUEID chapterId, i.ZTITLE chapterTitle, c.ZCOURSEID courseId, c.ZREFERENCE courseReference
  FROM ZILPEXERCISE x
  JOIN ZILPISSUEDEF i ON i.Z_PK = x.ZISSUE
  JOIN ZILPCOURSEDEF c ON c.Z_PK = i.ZCOURSE`;

export function listExercises({ course, chapter, onlyOpen } = {}) {
  const where = [];
  const params = [];
  if (course) {
    where.push('c.ZCOURSEID = ?');
    params.push(course);
  }
  if (chapter) {
    where.push('i.ZISSUEID = ?');
    params.push(chapter);
  }
  if (onlyOpen) where.push('COALESCE(x.ZPROCESSED, 0) = 0');
  const sql = `${EXERCISE_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY c.ZTABORDER, i.ZORDER, x.ZSORTKEY, x.ZORDER`;
  return query(sql, params).map((r) => ({ ...r, done: r.processed === 1, processed: undefined }));
}

// The exercise next to `ref` in the book's order (also across chapters).
export function neighbourExercise(ref, course, direction) {
  const list = listExercises({ course });
  const index = list.findIndex((r) => r.ref === ref);
  if (index === -1) throw new Error(`Exercise ${ref} not found in ${course}`);
  const next = list[index + (direction === 'previous' ? -1 : 1)];
  if (!next) throw new Error(`There is no ${direction} exercise after ${ref}`);
  return next;
}

// Of the given exercise references, the one beook opened most recently.
export function mostRecentlyOpened(refs) {
  if (refs.length === 0) return null;
  const rows = query(
    `SELECT ZREFERENCE ref FROM ZILPEXERCISE WHERE ZREFERENCE IN (${refs.map(() => '?').join(',')})
     ORDER BY COALESCE(ZLASTACCESS, 0) DESC LIMIT 1`,
    refs,
  );
  return rows[0]?.ref ?? null;
}

export function findExercise(ref, course) {
  const rows = query(
    `${EXERCISE_SELECT} WHERE x.ZREFERENCE = ? ${course ? 'AND c.ZCOURSEID = ?' : ''}`,
    course ? [ref, course] : [ref],
  );
  if (rows.length === 0) throw new Error(`No exercise with reference ${ref}${course ? ` in ${course}` : ''}`);
  if (rows.length > 1) {
    throw new Error(`Reference ${ref} exists in several books (${rows.map((r) => r.courseId).join(', ')}); pass "course".`);
  }
  return rows[0];
}
