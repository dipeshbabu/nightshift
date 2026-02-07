export const bootPrompt = (userIntent: string) =>
  `
You are bootstrapping a new workspace for the user.Their stated purpose is:
"${userIntent}"

## Important: Interview the User

If asked to read from a BOOT.md file, you must read it first.There will be information useful for you to help the user.

If there is a mention of Skills in either Markdown or JSON in the BOOT.md, you MUST use those to create skill files in your current working directory in the path.opencode / skills / <name>/SKILL.md.

NEVER ASK QUESTIONS

## After gathering information:

1. ** TODO project tracker **: You need to set up a TODO for this bootstrapping task so you don't forget any steps. Validate by reading back the TODOs and the environment.
1. ** Install packages **: Run \`uv add <packages>\` to install Python libraries appropriate for this use case
2. **Create library structure**: Add modules to src/agent_lib/ that will help with the stated purpose
3. **Generate SKILLS.md for each skill needed**: Create a SKILL.md at .opencode/skills/<name>/SKILL.md file with the SKILL.
3. **Generate AGENTS.md**: Create an AGENTS.md file following these best practices:

## SKILLS.md Guidelines:

You should always look up best practices for creating SKILLs.md files online before generating one. An extensive web search is recommended.

## AGENTS.md Guidelines:

You should always look up best practices for creating AGENTS.md files online before generating one. An extensive web search is recommended.

### Required Sections:
- **Project Overview**: One-sentence description tailored to "${userIntent}"
- **Commands**: Exact commands for build, test, run (use bun, uv, pytest)
- **Tech Stack**: Python 3.13, Bun, uv, and installed packages
- **Project Structure**: Key file paths and their purposes
- **Code Style**: Formatting rules, design patterns (use ruff, black)
- **Do's and Don'ts**: Specific, actionable guidelines for this use case
- **Safety Boundaries**:
  - Always do: Read files, run tests, format code
  - Ask first: Install new packages, modify pyproject.toml
  - Never do: Delete data, run destructive commands

### Style Guidelines:
- Be specific, not vague
- Use code examples, not descriptions
- Make commands copy-pasteable
- Prioritize capabilities over file structure
`.trim();
