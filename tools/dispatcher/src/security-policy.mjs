// Semantic hard-deny classification used by the shared worker guard.
//
// This is an audit layer, not the sole enforcement boundary: worker-guard.mjs
// also applies an inherited macOS sandbox, removes privileged credentials,
// validates the resulting diff, and keeps all remote publication in the
// trusted dispatcher process.

// Word-only stand-ins for escaped shell operators: the placeholder itself
// must contain none of `;`, `|`, `&`, `<`, `>`, or shellSegments' split below would
// re-split on the placeholder's own text and undo the escaping it exists to
// provide (MOV-244 hit this with a quoted `\|` inside a `grep` pattern).
const ESCAPED_OPERATOR_PLACEHOLDERS = {
  ";": "__escaped_semicolon__",
  "|": "__escaped_pipe__",
  "&": "__escaped_amp__",
  "<": "__escaped_lt__",
  ">": "__escaped_gt__",
};

// Quoted operators are literal arguments (for example grep -E "a|b", or the
// comparison in awk '$3 > $2'), not shell boundaries or redirects. Keep
// substitutions and shell-wrapper bodies visible to the conservative audit
// rather than trying to parse executable shell code.
function protectQuotedOperators(text) {
  if (/\$\(|`/.test(text) || /\b(?:sh|bash|zsh)\s+-c\b|\beval\b/.test(text)) return text;
  return text.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, (quoted) =>
    quoted.replace(/[;|&<>]/g, (operator) => ESCAPED_OPERATOR_PLACEHOLDERS[operator]),
  );
}

// `lines: true` keeps each newline as a command boundary. It is used only on
// shellView() output, whose sole remaining newlines are unquoted command
// separators; everything else still collapses to one line as before.
function canonicalize(text, { lines = false } = {}) {
  const normalized = protectQuotedOperators(String(text || ""))
    // An escaped shell operator is literal data, not a command separator. Keep
    // it distinct while normalizing so a regex such as `foo\\|git` cannot be
    // mistaken for a pipeline that invokes Git.
    .replace(/\\([;|&<>])/g, (_, operator) => ESCAPED_OPERATOR_PLACEHOLDERS[operator])
    .replace(/\\\s/g, " ")
    .replace(/["'`]/g, "");
  return (lines ? normalized.replace(/[^\S\n]+/g, " ").replace(/\s*\n\s*/g, "\n") : normalized.replace(/\s+/g, " "))
    .trim()
    .toLowerCase();
}

function shellSegments(normalized) {
  return normalized.split(/\s*(?:&&|\|\||[;|&\n])\s*/);
}

// --- Shell data versus shell commands (MOV-398) ---------------------------
//
// A heredoc body and an inline interpreter script are content the worker is
// writing or running, not shell it is executing. shellView() separates them
// from the command lines with a small quote-aware scan. It only ever *removes*
// text when it can prove the shell would treat that text as data; any
// construct it does not fully understand leaves the action "inexact", and
// classifyAction() then keeps the pre-MOV-398 whole-text classification as
// well, so an unparsed action is never judged more leniently than before.

// Consumers whose heredoc body is data: plain file writers and interpreters
// fed from stdin (`python3 -`, `node -`). Anything else, notably a shell,
// keeps its body under command classification.
const HEREDOC_DATA_CONSUMERS = /^(?:cat|tee|python(?:3(?:\.\d+)?)?|node)$/;
const INLINE_SCRIPT_FLAGS = { python: /^-c$/, node: /^(?:-e|-p|--eval|--print)$/ };
const INLINE_SCRIPT_PLACEHOLDER = "__inline_script__";
// A command word that can evaluate text as shell: shells and their wrappers,
// compound-command keywords (`while read c; do $c; done <<EOF`), and dynamic
// or local-script command names. Its presence anywhere keeps heredoc bodies
// classified, because they may be fed to it.
const SHELL_EVALUATORS = /^(?:sh|bash|zsh|dash|ksh|fish|csh|tcsh|eval|source|\.|exec|xargs|parallel|env|sudo|doas|command|builtin|nohup|time|timeout|nice|watch|script|osascript|coproc|while|until|for|select|if|then|elif|else|do|done|case|esac|function|\{|\}|\[\[|!)$/;
const HEREDOC_DELIMITER = /^[A-Za-z0-9_.-]+$/;
const WORD_BREAK = /[\s;&|<>()]/;

function basename(word) {
  return String(word).split("/").pop();
}

function commandWord(words) {
  return words.find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) ?? null;
}

function interpreterOf(word) {
  const name = basename(word);
  if (/^python(?:3(?:\.\d+)?)?$/.test(name)) return "python";
  return name === "node" ? "node" : null;
}

function evaluatesShell(word) {
  return SHELL_EVALUATORS.test(basename(word)) || /[$`]/.test(word) || /^(?:\.{1,2}\/|~)/.test(word) || /\.(?:sh|bash|zsh)$/.test(word);
}

// Parse `<<[-]WORD` starting at `start`. Only a plain delimiter, optionally
// quoted or backslash-escaped, is accepted; anything else returns null.
function parseHeredocOpener(src, start) {
  let pos = start + 2;
  if (src[pos] === "-") pos += 1;
  while (src[pos] === " " || src[pos] === "\t") pos += 1;
  let delimiter = "";
  let quoted = false;
  while (pos < src.length && !WORD_BREAK.test(src[pos])) {
    const ch = src[pos];
    if (ch === "'" || ch === '"') {
      const close = src.indexOf(ch, pos + 1);
      if (close === -1) return null;
      delimiter += src.slice(pos + 1, close);
      quoted = true;
      pos = close + 1;
    } else if (ch === "\\") {
      delimiter += src[pos + 1] ?? "";
      quoted = true;
      pos += 2;
    } else {
      delimiter += ch;
      pos += 1;
    }
  }
  return HEREDOC_DELIMITER.test(delimiter) ? { delimiter, quoted, end: pos } : null;
}

// Read a heredoc body from `start` to its terminator line. Whitespace around
// the terminator is ignored: that can only end the body earlier than the
// shell does, which leaves more text under command classification, never less.
function readHeredocBody(src, start, delimiter) {
  for (let pos = start; ; ) {
    const newline = src.indexOf("\n", pos);
    const lineEnd = newline === -1 ? src.length : newline;
    if (src.slice(pos, lineEnd).trim() === delimiter) {
      return { body: src.slice(start, pos), end: newline === -1 ? src.length : newline + 1, terminated: true };
    }
    if (newline === -1) return { body: src.slice(start), end: src.length, terminated: false };
    pos = newline + 1;
  }
}

// A quoted `python3 -c` / `node -e` argument is the interpreter's program.
// A double-quoted one is data only when it holds no command substitution,
// which the shell would still expand.
function inlineScriptAt(src, start, words) {
  const program = commandWord(words);
  const flags = program && INLINE_SCRIPT_FLAGS[interpreterOf(program)];
  if (!flags || !flags.test(words[words.length - 1])) return null;
  const quote = src[start];
  let pos = start + 1;
  while (pos < src.length && src[pos] !== quote) pos += quote === '"' && src[pos] === "\\" ? 2 : 1;
  if (pos >= src.length) return null;
  const text = src.slice(start, pos + 1);
  if (quote === '"' && /\$\(|`/.test(text)) return null;
  if (pos + 1 < src.length && !WORD_BREAK.test(src[pos + 1])) return null;
  return { text, end: pos + 1 };
}

/**
 * Split a shell command into the text that runs as commands and the text that
 * is data. Returns two renderings: `command` (heredoc bodies removed, inline
 * scripts replaced by a placeholder) and `script` (heredoc bodies removed,
 * inline scripts kept). Unquoted newlines stay as newlines; quoted ones become
 * spaces. `exact` is false when anything was left unparsed or ambiguous; then
 * both renderings keep every heredoc body.
 */
export function shellView(text) {
  const src = String(text || "");
  const command = [];
  const script = [];
  const emit = (commandText, scriptText = commandText) => {
    command.push(commandText);
    script.push(scriptText);
  };
  const segments = [{ words: [] }];
  const heredocs = [];
  let pending = [];
  let word = null;
  let quote = null;
  let comment = false;
  let substitution = false;
  let malformed = false;
  const segment = () => segments[segments.length - 1];
  const finishWord = () => {
    if (word !== null) segment().words.push(word);
    word = null;
  };
  const newSegment = () => {
    finishWord();
    if (segment().words.length) segments.push({ words: [] });
  };

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    const next = src[i + 1];
    if (comment) {
      if (ch !== "\n") {
        // Comment text stays classified, but its quotes are not shell quotes.
        emit(/["'`]/.test(ch) ? " " : ch);
        continue;
      }
      comment = false;
    }
    if (quote === "'" || quote === "$'") {
      if (quote === "$'" && ch === "\\" && next !== undefined) {
        emit(ch + next);
        word += next;
        i += 1;
        continue;
      }
      emit(ch === "\n" ? " " : ch);
      if (ch === "'") quote = null;
      else word += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\" && next !== undefined) {
        if (next !== "\n") {
          emit(ch + next);
          word += next;
        }
        i += 1;
        continue;
      }
      if (ch === "`" || (ch === "$" && next === "(")) substitution = true;
      emit(ch === "\n" ? " " : ch);
      if (ch === '"') quote = null;
      else word += ch;
      continue;
    }

    if (ch === "\\") {
      if (next === "\n") {
        i += 1;
      } else if (next === undefined) {
        emit(ch);
      } else {
        word = (word ?? "") + next;
        emit(ch + next);
        i += 1;
      }
      continue;
    }
    if (ch === "#" && word === null) {
      comment = true;
      emit(ch);
      continue;
    }
    if (ch === "'" || ch === '"') {
      const inline = word === null ? inlineScriptAt(src, i, segment().words) : null;
      if (inline) {
        emit(INLINE_SCRIPT_PLACEHOLDER, inline.text.replace(/\n/g, " "));
        word = INLINE_SCRIPT_PLACEHOLDER;
        i = inline.end - 1;
        continue;
      }
      quote = ch;
      word = word ?? "";
      emit(ch);
      continue;
    }
    if (ch === "$" && next === "'") {
      quote = "$'";
      word = word ?? "";
      emit("$'");
      i += 1;
      continue;
    }
    if (ch === "`" || (ch === "$" && next === "(") || ((ch === "<" || ch === ">") && next === "(")) substitution = true;
    if (ch === "<" && next === "<" && src[i + 2] === "<") {
      finishWord();
      segment().words.push("<<<");
      emit("<<<");
      i += 2;
      continue;
    }
    if (ch === "<" && next === "<") {
      finishWord();
      const opener = parseHeredocOpener(src, i);
      if (!opener) {
        malformed = true;
        segment().words.push("<<");
        emit("<<");
        i += 1;
        continue;
      }
      pending.push({ ...opener, segment: segment() });
      segment().words.push("<<");
      emit(src.slice(i, opener.end));
      i = opener.end - 1;
      continue;
    }
    if (ch === "<" || ch === ">" || (ch === "&" && next === ">")) {
      finishWord();
      const operator = /[<>&|]/.test(next ?? "") ? ch + next : ch;
      segment().words.push(operator);
      emit(operator);
      i += operator.length - 1;
      continue;
    }
    if (ch === ";" || ch === "&" || ch === "|" || ch === "(" || ch === ")") {
      newSegment();
      emit(ch);
      continue;
    }
    if (ch === "\n") {
      newSegment();
      emit("\n");
      // Heredoc bodies begin after the newline that ends their opener line.
      let pos = i + 1;
      for (const opener of pending) {
        const read = readHeredocBody(src, pos, opener.delimiter);
        const heredoc = { ...opener, ...read };
        heredocs.push(heredoc);
        command.push(heredoc);
        script.push(heredoc);
        pos = read.end;
      }
      pending = [];
      i = pos - 1;
      continue;
    }
    if (/\s/.test(ch)) {
      finishWord();
      emit(ch);
      continue;
    }
    word = (word ?? "") + ch;
    emit(ch);
  }
  finishWord();

  const heredocsAreData = heredocs.every((heredoc) => {
    const consumer = commandWord(heredoc.segment.words);
    return heredoc.terminated
      // An unquoted delimiter still expands `$(…)` and backticks in the body.
      && (heredoc.quoted || !/\$\(|`/.test(heredoc.body))
      && consumer !== null
      && HEREDOC_DATA_CONSUMERS.test(basename(consumer));
  });
  const feedsShell = heredocs.length > 0 && segments.some(({ words }) => {
    const name = commandWord(words);
    return name !== null && evaluatesShell(name);
  });
  const exact = quote === null && pending.length === 0 && !malformed && !substitution && heredocsAreData && !feedsShell;
  const render = (chunks) => chunks.map((chunk) => (typeof chunk === "string" ? chunk : exact ? "" : chunk.body)).join("");
  return { exact, command: render(command), script: render(script) };
}

// Codex reports every command as `bash -lc '<script>'`. When the wrapper's
// argument is one plainly quoted word, classify the script it runs; any
// other shape returns null and is classified as written.
function unwrapShellWrapper(text) {
  const match = /^\s*(?:\/(?:usr\/(?:local\/)?)?bin\/|\/opt\/homebrew\/bin\/)?(?:bash|zsh|sh) +-l?c +(\S[\s\S]*?)\s*$/.exec(String(text || ""));
  if (!match) return null;
  const argument = match[1];
  let inner = "";
  for (let pos = 0; pos < argument.length; ) {
    const ch = argument[pos];
    if (ch === "'" || ch === '"') {
      const close = argument.indexOf(ch, pos + 1);
      if (close === -1) return null;
      const part = argument.slice(pos + 1, close);
      if (ch === '"' && /[$`\\]/.test(part)) return null;
      inner += part;
      pos = close + 1;
    } else if (ch === "\\" && pos + 1 < argument.length && argument[pos + 1] !== "\n") {
      inner += argument[pos + 1];
      pos += 2;
    } else if (/[\w/.,:=+@%-]/.test(ch)) {
      inner += ch;
      pos += 1;
    } else {
      return null;
    }
  }
  return inner;
}

function isCredentialOperation(segment) {
  if (!/\bnpm\b/.test(segment)) return false;

  // `npm run <script>` is local script execution. Its script name and
  // pass-through test paths must not be interpreted as npm credential access.
  // Other npm subcommands retain the existing conservative detection.
  const withoutRunInvocation = segment.replace(/\bnpm\s+run\s+\S+(?:\s+.*)?$/, "npm run");
  return /\bnpm\b[^\n]*(?:secret|credential|token|password)/.test(withoutRunInvocation);
}

// --- Protected paths (MOV-400) ---------------------------------------------
//
// Two layers enforce protected paths without reading command text: the
// Seatbelt profile from buildWorkerSandboxProfile denies every write to them,
// and auditChangedPaths fails publication when one appears in the worker's
// diff, however it was written. The command audit therefore blocks only a
// command that clearly *writes* a protected path, so intent still surfaces
// when the sandbox stopped it. A command that merely names one is an audit
// warning, and a known read-only inspection is not reported at all.
//
// Write detection is lexical and deliberately generous: a redirect target, a
// `tee` operand, an in-place `sed`/`perl`/`awk` edit, a `cp`/`ln` destination,
// any `mv`/`rm`/editor operand, or a mutating `find`. When the written operand
// is only a variable (`"$f"`), a find/xargs placeholder, or input from `xargs`,
// it counts as a write of every protected path the action names. What it
// misses is still stopped by the sandbox and the diff audit.

// Known read-only inspections of a protected path are not reported. Keep this
// list small and boring; anything else that names a path without writing it
// is a warning, not a denial.
const READ_ONLY_PATH_COMMANDS = /^(?:cat|head|tail|grep|rg|ls|stat|sed|find)\b/;

// A repair worker must still be able to read and run the paths repair mode
// marks read-only (tests, dispatcher code, governance docs, test config) —
// "read-only" means it cannot edit them, not that it cannot look at or
// execute them, per docs/operators/local-execution.md's repair-mode
// description. Running the project's own test runner against a protected
// path is inspection unless it carries a snapshot-writing flag.
const REPAIR_READ_ONLY_COMMANDS = /^(?:cat|head|tail|grep|rg|ls|stat|sed|find|npx\s+vitest|vitest|npx\s+playwright|playwright|npm\s+(?:run\s+)?test)\b/;

function writesTestSnapshot(segment) {
  return /^(?:npx\s+)?(?:vitest|playwright)\b[^\n]*\s(?:-u|--update(?:-snapshots)?)\b/.test(segment);
}

// Commands that change every file operand they are given.
const OPERAND_WRITERS = /^(?:rm|rmdir|unlink|mv|touch|truncate|chmod|chown|chgrp|chflags|xattr|mkdir|shred|srm|trash|tee|edit|ed|ex|vi|vim|nvim|nano|emacs|pico)$/;
// Commands that write only their destination: `-t DIR`, else the last operand.
const DESTINATION_WRITERS = /^(?:cp|ln|install|rsync|ditto)$/;
// Words that run the command after them. Their own options are skipped.
const COMMAND_WRAPPERS = /^(?:do|then|else|elif|if|while|until|!|\{|time|nohup|command|builtin|exec|eval|sudo|doas|env|nice|timeout|sh|bash|zsh|dash|ksh)$/;
// xargs options that take a separate argument (lowercased by canonicalize).
const XARGS_ARGUMENT_OPTIONS = /^-(?:[ilnpsedaj]|-(?:max-args|max-lines|max-procs|delimiter|eof|arg-file|replace))$/;
// A find primary that runs a command, deletes, or writes a file.
const FIND_MUTATION = /(?:^|\s)-(?:exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)\b/;
// An operand that is only a variable or a placeholder: its value is unknown.
const INDIRECT_OPERAND = /^(?:\$(?:\{?[a-z_][a-z0-9_]*\}?|\d|@|\*)|\{\})$/;
const REDIRECTION = /(?:\d+)?(>>|>\||>&|>|<>|<<<|<<-?|<&|<)\s*([^\s<>]*)/g;

function pathToken(token) {
  return token.replace(/^\(+/, "").replace(/\)+$/, "").replace(/^(?:\.\/)+/, "");
}

function isWriter(word) {
  const name = basename(pathToken(word));
  return OPERAND_WRITERS.test(name) || DESTINATION_WRITERS.test(name) || /^(?:sed|perl|g?awk|dd|find)$/.test(name);
}

// Skip wrappers (`do`, `sudo`, `sh -c`, `xargs -n1` …) to reach the command a
// segment actually runs. `viaXargs` means operands also arrive on stdin;
// `placeholder` means xargs substitutes them explicitly (`-I{}`).
function effectiveCommand(words) {
  let index = 0;
  let viaXargs = false;
  let placeholder = false;
  while (index < words.length) {
    const word = pathToken(words[index]);
    if (/^[a-z_][a-z0-9_]*=/.test(word) || word === "") {
      index += 1;
    } else if (basename(word) === "xargs") {
      viaXargs = true;
      index += 1;
      while (index < words.length && words[index].startsWith("-")) {
        if (/^-(?:i|j)|^--replace/.test(words[index])) placeholder = true;
        const takesArgument = XARGS_ARGUMENT_OPTIONS.test(words[index]);
        index += 1;
        if (takesArgument && index < words.length && !isWriter(words[index])) index += 1;
      }
    } else if (COMMAND_WRAPPERS.test(basename(word))) {
      const wrapper = basename(word);
      index += 1;
      while (index < words.length && (words[index].startsWith("-") || /^[a-z_][a-z0-9_]*=/.test(words[index])
        || ((wrapper === "nice" || wrapper === "timeout") && /^[\d.]+[smhd]?$/.test(words[index])))) index += 1;
    } else {
      break;
    }
  }
  return { name: index < words.length ? basename(pathToken(words[index])) : null, args: words.slice(index + 1), viaXargs, placeholder };
}

// The operands one shell segment writes. Redirect targets are writes whatever
// the command; the command's own write positions are added on top.
function segmentWriteTargets(segment) {
  const targets = [];
  const bare = segment.replace(REDIRECTION, (_match, operator, target) => {
    const fdDuplicate = operator === ">&" && /^(?:\d+|-)?$/.test(target);
    if ((operator.startsWith(">") || operator === "<>") && !fdDuplicate) targets.push(target);
    return " ";
  });
  const words = bare.split(" ").filter(Boolean);
  const { name, args, viaXargs, placeholder } = effectiveCommand(words);
  if (!name) return targets;
  const operands = args.filter((arg) => !arg.startsWith("-"));
  // Arguments from stdin are appended after the written command's own.
  if (viaXargs && !placeholder) operands.push("{}");

  if (name === "find") {
    // A mutating find names its targets anywhere: a start directory, a
    // `-name` match, or the file a `-fprint` writes. Its `{}` is find's own
    // match, already covered by those names.
    if (FIND_MUTATION.test(segment)) targets.push(...args.filter((arg) => arg !== "{}"));
  } else if (OPERAND_WRITERS.test(name) || args.some((arg) => arg === "--write" || arg === "--fix")) {
    targets.push(...operands);
  } else if (DESTINATION_WRITERS.test(name)) {
    const target = args.findIndex((arg) => arg === "-t" || arg === "--target-directory");
    const inline = args.find((arg) => arg.startsWith("--target-directory="));
    if (inline) targets.push(inline.slice("--target-directory=".length));
    else if (target !== -1 && target + 1 < args.length) targets.push(args[target + 1]);
    else if (operands.length > 1 || viaXargs) targets.push(operands.at(-1));
  } else if ((name === "sed" && args.some((arg) => /^(?:-[a-z]*i|--in-place)/.test(arg)))
    || (name === "perl" && args.some((arg) => /^-[a-z]*i/.test(arg)))
    || (/^g?awk$/.test(name) && args.includes("inplace"))) {
    targets.push(...operands);
  } else if (name === "dd") {
    targets.push(...args.filter((arg) => arg.startsWith("of=")).map((arg) => arg.slice(3)));
  }
  return targets;
}

function namesPath(token, rule) {
  return rule.token.test(pathToken(token));
}

// A bare word such as `test` is a mention only in a write position; anywhere
// else it must look like a path (`docs/product`, `.claude`).
function mentionsPath(text, rule) {
  return rule.re.test(text) || text.split(/[\s;|&<>]+/).some((word) => /[./]/.test(word) && namesPath(word, rule));
}

function writesProtectedPath(normalized, rule, workerMode) {
  const mentioned = mentionsPath(normalized, rule);
  return shellSegments(normalized).some((segment) =>
    (workerMode === "repair" && rule.repair && mentionsPath(segment, rule) && writesTestSnapshot(segment))
    || segmentWriteTargets(segment).some((target) => namesPath(target, rule) || (mentioned && INDIRECT_OPERAND.test(pathToken(target)))),
  );
}

function isReadOnlyInspection(normalized, rule, readOnlyCommands) {
  const references = shellSegments(normalized).filter((segment) => mentionsPath(segment, rule));
  return references.length > 0 && references.every((segment) => readOnlyCommands.test(segment));
}

// A scope rule protects the dispatcher's ownership of an operational tool.
// A safety rule protects secrets, irreversible actions, or the policy itself.
// The distinction is consumed by worker-guard.mjs: a command the native
// harness demonstrably denied is a warning only for scope rules, while every
// safety attempt remains fail-closed.
//
// `credential: true` marks a credential rule: it reads the view in which an
// inline interpreter script is data (see classifyNormalized). A normalized
// action keeps unquoted newlines, so `[^\n]*` never reaches another line.
export const COMMAND_RULES = [
  {
    re: /(?:^|[;&|\n]\s*|\b(?:command|exec|xcrun|sh +-c|bash +-c|zsh +-c) +|\/)(?:usr\/bin\/|usr\/local\/bin\/|opt\/homebrew\/bin\/)?git\b/,
    reason: "all Git operations are dispatcher-only",
    category: "scope",
  },
  { re: /\bsecurity +(?:find|dump|export|unlock|set|add|delete)-/, reason: "keychain access from a worker", category: "safety" },
  // The tool and the credential word must share one shell segment: a later
  // `grep token` or a line of file content is not `gh`/`supabase` access.
  {
    test: (normalized) => shellSegments(normalized).some((segment) => /\b(?:gh|vercel|supabase|aws)\b.*(?:secret|credential|token|password)/.test(segment)),
    reason: "secret or credential mutation/access",
    category: "safety",
    credential: true,
  },
  {
    test: (normalized) => shellSegments(normalized).some(isCredentialOperation),
    reason: "secret or credential mutation/access",
    category: "safety",
    credential: true,
  },
  { re: /\b(?:printenv|env|set)\b[^\n]*(?:key|token|secret|password)/, reason: "prints credential-shaped environment data", category: "safety", credential: true },
  { re: /\b(?:echo|printf)\b[^;|&\n]*(?:key|token|secret|password)/, reason: "prints credential-shaped data", category: "safety", credential: true },
  { re: /supabase_db_url_prod/, reason: "references the production database URL", category: "safety" },
  { re: /\bsupabase\b[^\n]*(?:db +(?:reset|push)|migration +up|link|functions +deploy|projects? +(?:create|delete))\b/, reason: "mutates a Supabase resource", category: "safety" },
  { re: /\bvercel\b[^\n]*(?:--prod\b| +deploy\b| +promote\b| +alias\b| +domains?\b| +env\b)/, reason: "mutates a Vercel or production resource", category: "safety" },
  { re: /\bgh +release\b/, reason: "mutates a GitHub release", category: "safety" },
  { re: /\bnpm +publish\b/, reason: "publishes a package", category: "safety" },
  // Keep generic operational ownership rules after the safety-specific
  // variants above: `gh secret set` and `gh release` must not be downgraded
  // to a scope finding merely because they also contain the `gh` binary.
  { re: /\bgh\b/, reason: "GitHub CLI access is dispatcher-only", category: "scope" },
  { re: /\b(?:curl|wget)\b[^\n]*(?:api\.github\.com|github\.com\/api|uploads\.github\.com)/, reason: "alternate GitHub API path", category: "scope" },
  { re: /\b(?:ssh|scp|sftp)\b/, reason: "direct SSH transport is not available to workers", category: "scope" },
];

// `re` finds a mention anywhere in the action; `token` matches one written
// operand. `reason` is the hard-deny for a detected write, and `path` names
// the protected path in the warning for a mention.
export const PATH_RULES = [
  { re: /(?:^|\s)\.github\/workflows\//, token: /^\.github\/workflows(?:\/|$)/, path: ".github/workflows/**", reason: "modifies .github/workflows/**", category: "safety" },
  { re: /(?:^|\s)agents\.md\b/, token: /^agents\.md$/, path: "AGENTS.md", reason: "edits AGENTS.md", category: "safety" },
  { re: /\.github\/copilot-instructions\.md\b/, token: /(?:^|\/)\.github\/copilot-instructions\.md$/, path: ".github/copilot-instructions.md", reason: "edits .github/copilot-instructions.md", category: "safety" },
  { re: /(?:^|\s)docs\/product\//, token: /^docs\/product(?:\/|$)/, path: "docs/product/**", reason: "edits docs/product/**", category: "safety" },
  { re: /(?:^|\s)\.claude\//, token: /^\.claude(?:\/|$)/, path: ".claude/**", reason: "edits worker permission policy", category: "safety" },
  { re: /(?:^|\s)\.codex\//, token: /^\.codex(?:\/|$)/, path: ".codex/**", reason: "edits worker sandbox policy", category: "safety" },
];

const REPAIR_ONLY_RULES = [
  { re: /(?:^|\s)(?:test|tests|e2e)\//, token: /^(?:test|tests|e2e)(?:\/|$)/, path: "test/**, tests/** or e2e/**", reason: "repair workers cannot change tests" },
  { re: /(?:^|\s)docs\/(?:governance|operators|planning)\//, token: /^docs\/(?:governance|operators|planning)(?:\/|$)/, path: "governance docs", reason: "repair workers cannot change governance" },
  { re: /(?:^|\s)tools\/dispatcher\//, token: /^tools\/dispatcher(?:\/|$)/, path: "tools/dispatcher/**", reason: "repair workers cannot change their dispatcher guard" },
  { re: /(?:^|\s)(?:package(?:-lock)?\.json|(?:playwright|vitest(?:\.[\w-]+)?)\.config\.[cm]?[jt]s)\b/, token: /^(?:package(?:-lock)?\.json|(?:playwright|vitest(?:\.[\w-]+)?)\.config\.[cm]?[jt]s)$/, path: "test execution configuration", reason: "repair workers cannot change test execution configuration" },
].map((rule) => ({ ...rule, category: "safety", repair: true }));

const HUMAN_DECISION_PATTERNS = [
  { re: /(?:^|\s)supabase\/migrations\//, reason: "database migration touching existing tables — needs human review" },
  { re: /(?:^|\s)src\/app\/(?:auth|settings\/calendar)\//, reason: "auth or calendar-token logic — needs human review" },
];

// `command` is the view for credential and path rules, where an inline
// interpreter script is data. `script` keeps that script for the remaining
// command rules (Git, gh, keychain, deploy and publish).
function classifyNormalized({ command: normalized, script, hasSubstitution }, workerMode) {
  for (const { re, test, reason, category, credential } of COMMAND_RULES) {
    const subject = credential ? normalized : script;
    if ((test ? test(subject) : re.test(subject))) return { verdict: "hard-deny", reason, category };
  }
  // A write blocks. A command substitution is shell the audit cannot read, so
  // one that shares an action with a protected path stays blocking too. A
  // plain mention is only a warning: see "Protected paths" above.
  let warning = null;
  const pathRules = workerMode === "repair" ? [...PATH_RULES, ...REPAIR_ONLY_RULES] : PATH_RULES;
  for (const rule of pathRules) {
    const mentioned = mentionsPath(normalized, rule);
    if (writesProtectedPath(normalized, rule, workerMode) || (hasSubstitution && rule.re.test(normalized))) {
      return { verdict: "hard-deny", reason: rule.reason, category: rule.category };
    }
    const readOnlyCommands = rule.repair ? REPAIR_READ_ONLY_COMMANDS : READ_ONLY_PATH_COMMANDS;
    if (!warning && mentioned && !isReadOnlyInspection(normalized, rule, readOnlyCommands)) {
      warning = { verdict: "warn", reason: `names protected path ${rule.path} without writing it`, category: rule.category };
    }
  }
  for (const { re, reason } of HUMAN_DECISION_PATTERNS) {
    if (re.test(normalized)) return { verdict: "needs-human", reason, category: "safety" };
  }
  return warning ?? { verdict: "allow", reason: null, category: null };
}

const VERDICT_SEVERITY = { allow: 0, warn: 1, "needs-human": 2, "hard-deny": 3 };

/**
 * Classify a structured tool command or file path. The verdict is `allow`,
 * `warn` (names a protected path without writing it), `needs-human`, or
 * `hard-deny`.
 */
export function classifyAction(text, { workerMode = "implementation" } = {}) {
  const raw = String(text || "");
  const unwrapped = unwrapShellWrapper(raw) ?? raw;
  const view = shellView(unwrapped);
  if (view.exact) {
    return classifyNormalized({
      command: canonicalize(view.command, { lines: true }),
      script: canonicalize(view.script, { lines: true }),
      hasSubstitution: false,
    }, workerMode);
  }
  // Not provably separable: keep the pre-MOV-398 whole-text classification
  // of both the written and unwrapped forms, and add line-aware readings that
  // also catch a command on a line of its own, including one inside a quoted
  // `bash -c "$(cat <<EOF …)"` body. The most severe verdict wins.
  const hasSubstitution = /\$\(|`/.test(raw);
  const candidates = [...new Set([raw, unwrapped])].map((form) => canonicalize(form));
  candidates.push(canonicalize(view.script, { lines: true }), canonicalize(unwrapped, { lines: true }));
  return candidates
    .map((normalized) => classifyNormalized({ command: normalized, script: normalized, hasSubstitution }, workerMode))
    .reduce((worst, verdict) => (VERDICT_SEVERITY[verdict.verdict] > VERDICT_SEVERITY[worst.verdict] ? verdict : worst));
}
