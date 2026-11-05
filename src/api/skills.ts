/**
 * The skills Fold serves agents, in the order its lists give them (crates/fold-store/src/skills.rs, which the test beside the connect page checks this against). Each is the same text for everyone and holds no space's data, so its download needs no access.
 *
 * Where Claude Code keeps a copy: `using-a-memory-space` as a personal skill, for every project; `engram-in-a-repository` as a project skill, committed in a repository Fold indexes, since it has an agent write and commit an `engram/` folder and belongs nowhere else.
 */
export const SKILLS = [
	{ name: "using-a-memory-space", fits: "a space Fold keeps: searching it, saving notes, adding documents and correcting what it holds", keep: "personal" },
	{ name: "engram-in-a-repository", fits: "a repository's space, whose memory the repository keeps in its own engram/ folder", keep: "project" },
] as const;

/** Where Claude Code finds a skill of each kind: a personal one in the person's home, a project one in the repository it is run in. */
const FOLDERS = { personal: "~/.claude/skills", project: ".claude/skills" } as const;

export type SkillName = (typeof SKILLS)[number]["name"];

/** Where the query part serves a skill as Markdown: `GET /v1/skills/{name}`. */
export function skillUrl(queryUrl: string, name: SkillName): string {
	return `${queryUrl}/v1/skills/${name}`;
}

/** The skill's MCP resource on Fold's MCP server, as the Skills extension names one. */
export function skillResource(name: SkillName): string {
	return `skill://${name}/SKILL.md`;
}

/** The skill that fits a space: a repository's space keeps its memory in the repository, and every other space is used through Fold's tools. */
export function skillFor(synced: boolean): SkillName {
	return synced ? "engram-in-a-repository" : "using-a-memory-space";
}

/** The command that keeps a copy where Claude Code finds it: `<folder>/<name>/SKILL.md`. */
export function installCommand(queryUrl: string, skill: (typeof SKILLS)[number]): string {
	const folder = `${FOLDERS[skill.keep]}/${skill.name}`;
	return `mkdir -p ${folder} && curl -fsSL ${skillUrl(queryUrl, skill.name)} -o ${folder}/SKILL.md`;
}
