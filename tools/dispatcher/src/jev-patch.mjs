// The Jev arm exposes a regular function to models that cannot emit Codex's
// native custom tool grammar. Codex's unknown-model tool set has exec_command;
// translate back to the installed apply_patch executable in that executor.
import fs from "node:fs";
import path from "node:path";

export const JEV_PATCH_TOOL = Object.freeze({
  type: "function", name: "apply_patch",
  description: "Apply a Codex patch inside the current worktree. Supply the complete *** Begin Patch through *** End Patch text.",
  parameters: { type: "object", properties: { patch: { type: "string", description: "Complete Codex patch text" } },
    required: ["patch"], additionalProperties: false },
});

export function offerJevPatch(body, side) {
  if (side === "control") return body;
  const tools = Array.isArray(body.tools) ? body.tools : [];
  if (tools.some((tool) => tool.name === "apply_patch")) throw new Error("ambiguous Jev patch tool");
  return { ...body, tools: [...tools, JEV_PATCH_TOOL] };
}

function patchError(message) {
  return { cmd: `printf '%s\\n' 'Patch error: ${message}' >&2; exit 1`, login: false };
}

export function patchCommand(argumentsText, cwd) {
  let args;
  try { args = JSON.parse(argumentsText); } catch { return patchError("invalid JSON arguments; send {patch: string}"); }
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).join() !== "patch"
    || typeof args.patch !== "string" || args.patch.length > 1024 * 1024
    || !args.patch.startsWith("*** Begin Patch\n") || !args.patch.endsWith("\n*** End Patch")) {
    return patchError("expected one complete patch string");
  }
  const headers = [...args.patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map((match) => match[1]);
  if (!headers.length) return patchError("patch has no file actions");
  const root = fs.realpathSync(cwd);
  for (const name of headers) {
    if (!name || name.includes("\0") || name.includes("\n")) return patchError("invalid patch path");
    const target = path.resolve(root, name);
    if (target === root || !target.startsWith(`${root}${path.sep}`)) return patchError("path is outside the worktree");
    const relative = path.relative(root, target).split(path.sep);
    if (relative.some((part) => part === ".git" || part === "..")) return patchError("protected patch path");
    let parent = target;
    while (!fs.existsSync(parent)) parent = path.dirname(parent);
    if (!fs.realpathSync(parent).startsWith(`${root}${path.sep}`) && fs.realpathSync(parent) !== root) {
      return patchError("path resolves outside the worktree");
    }
  }
  // A quoted here-document prevents interpolation. The delimiter cannot be
  // forged by patch content because it is chosen after inspecting that text.
  let marker = "MOVIECAL_JEV_PATCH";
  while (args.patch.split("\n").includes(marker)) marker += "_X";
  return { cmd: `apply_patch <<'${marker}'\n${args.patch}\n${marker}`, workdir: root, login: false };
}

export function translateJevPatchEvent(value, cwd) {
  if (value?.type !== "response.output_item.done" || value.item?.type !== "function_call"
    || value.item.name !== "apply_patch") return value;
  return { ...value, item: { ...value.item, name: "exec_command",
    arguments: JSON.stringify(patchCommand(value.item.arguments, cwd)) } };
}

export function createJevPatchTranslator(cwd) {
  const patchIndexes = new Set();
  return (value) => {
    if (value?.type === "response.output_item.added" && value.item?.type === "function_call"
      && value.item.name === "apply_patch") {
      patchIndexes.add(value.output_index);
      return null;
    }
    if (patchIndexes.has(value?.output_index) && value.type !== "response.output_item.done") return null;
    if (value?.type === "response.output_item.done") patchIndexes.delete(value.output_index);
    return translateJevPatchEvent(value, cwd);
  };
}
