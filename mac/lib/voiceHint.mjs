// The live half of the vocabulary hint: from the panel's current work lines, the project names the
// user works in and the most recent conversation titles — what they tend to say out loud. Pure:
// lines in, { projects, titles } out; junk in, empty lists out; never throws.
//
// A line flagged `order: true` is automated work (a work order, not something anyone says out loud),
// so its title never becomes a hint word; its project still counts.
const MAX_TITLES = 10;

export function voiceHint({ lines, now = Date.now } = {}) {
  const at = () => (typeof now === 'function' ? now() : now);
  const list = Array.isArray(lines) ? lines.filter(l => l && typeof l === 'object') : [];
  const projects = [];
  const seenProject = new Set();
  const titled = [];
  for (const l of list) {
    const project = typeof l.project === 'string' ? l.project.trim() : '';
    if (project && project !== 'No workspace' && !seenProject.has(project.toLowerCase())) {   // 'No workspace' is summarize's placeholder, not a name
      seenProject.add(project.toLowerCase());
      projects.push(project);
    }
    if (l.order === true) continue;
    const title = typeof l.title === 'string' ? l.title.trim() : '';
    if (title) titled.push({ title, at: Number.isFinite(l.at) ? l.at : at() });
  }
  titled.sort((a, b) => b.at - a.at);
  const titles = [];
  const seenTitle = new Set();
  for (const { title } of titled) {
    const key = title.toLowerCase();
    if (seenTitle.has(key)) continue;
    seenTitle.add(key);
    titles.push(title);
    if (titles.length >= MAX_TITLES) break;
  }
  return { projects, titles };
}
