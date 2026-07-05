# Named Sessions and Git-Scoped Revert Documentation

This document explains the named sessions feature and git-scoped revert functionality implemented in Zizou AI.

## Overview

The implementation adds two major features:
1. **Named Sessions**: Multiple switchable working environments per project with persistent state
2. **Git-Scoped Revert**: Session-isolated git commits and revert operations

## Named Sessions

### Concept

Previously, Zizou had a 1:1 mapping between projects and sessions. Now, you can create multiple named sessions within a single project (e.g., "login-feature", "auth-feature"), each with its own:
- Conversation history
- Token statistics
- Pinned files
- Git branch
- Commit history

### Directory Structure

```
~/.zizou/sessions/<project-hash>/
  registry.json                    # Session metadata and active session pointer
  <session-id>/                    # UUID-based directory for each session
    state.json                     # Session state (conversation, tokens, pinned files)
    snapshots.json                 # Git commit history for this session
  .deleted/                        # Archived deleted sessions
    <session-id>/
      state.json
      snapshots.json
```

### Session Types

```typescript
interface SessionMeta {
  id: string;              // UUID
  name: string;            // User-facing name (e.g., "login-feature")
  createdAt: string;
  lastActiveAt: string;
  baseBranch: string;      // Git commit where session started
  branchName?: string;     // Git branch name (e.g., "zizou/login-feature")
}

interface SessionState {
  conversation: ModelMessage[];
  tokenStats: TokenStats;
  pinnedFiles: string[];
  createdAt: string;
  lastActiveAt: string;
}

interface Registry {
  activeSessionId: string | null;
  sessions: SessionMeta[];
}
```

### CLI Commands

#### `/session new <name>`
Creates a new session with the given name:
- Generates a UUID for the session
- Creates a git branch `zizou/<session-name>` from current HEAD
- Initializes empty session state
- Sets the new session as active

Example:
```
/session new login-feature
```

#### `/session list`
Lists all sessions with their status:
- Shows active session with `[ACTIVE]` marker
- Displays last active timestamp
- Shows creation date

Example:
```
Sessions:

  • login-feature [ACTIVE]
    Last active: 7/5/2026, 1:40:00 PM
  • auth-feature
    Last active: 7/4/2026, 10:00:00 PM
```

#### `/session switch <name>`
Switches to a different session:
- Checks git working tree cleanliness (blocks if dirty)
- Updates active session pointer in registry
- Loads the target session's state

Example:
```
/session switch auth-feature
```

**Safety Check**: If you have uncommitted git changes, the switch will be blocked:
```
Cannot switch sessions: working tree has uncommitted changes.
Please commit or discard changes before switching sessions.
```

#### `/session delete <name>`
Deletes a session:
- Refuses if the session is currently active
- Archives state.json and snapshots.json to `.deleted/` directory
- Does NOT delete the git branch (manual cleanup required)
- Removes session from registry

Example:
```
/session delete login-feature
Deleted session "login-feature". State archived to .deleted/
```

### Session Persistence

Sessions are automatically persisted:
- **On mount**: Chat.tsx loads the active session's state from disk
- **After each turn**: Conversation history, token stats, and pinned files are saved
- **On session switch**: State is cleared and new session's state is loaded

### Project Hashing

The project hash used for session directory structure is determined by:
1. Git commit hash (if in a git repository)
2. Directory path hash (if not in a git repo)

This ensures sessions are isolated per project.

## Git-Scoped Revert

### Concept

Each session has its own git branch and commit history. Revert operations are scoped to the active session only, preventing cross-session contamination.

### Session Branch Creation

When a new session is created:
- A git branch `zizou/<session-name>` is created from the current HEAD
- The starting commit SHA is recorded in `baseBranch`
- The branch name is stored in `SessionMeta.branchName`

### Per-Step Commits

After each verified step in the orchestrator:
- A git commit is created with message: `[<sessionId>] step <stepIndex>: <description>`
- The commit SHA is recorded in `snapshots.json`
- This happens in both build mode and plan mode

**Note**: Commits are only created if verification succeeds. Failed steps are not committed.

### Snapshots Tracking

The `snapshots.json` file tracks all commits for a session:

```typescript
interface SessionSnapshots {
  startCommit: string;
  commits: Array<{
    sha: string;
    stepIndex: number;
    description: string;
    timestamp: string;
  }>;
}
```

This provides a mapping between step indices and git commits, enabling revert by step number.

### Revert Commands

#### `/revert`
Reverts to the previous commit (last step):
- Shows which commits will be discarded
- Requires confirmation
- Executes `git reset --hard` to target commit
- Preserves history in `snapshots.json`

#### `/revert to <n>`
Reverts to a specific step number:
- Finds the commit for step `n` in snapshots.json
- Refuses if step `n` is not in session's history
- Shows commits that will be discarded
- Requires confirmation

Example:
```
/revert to 0
This will discard the following commits:
  Step 1: Implement login form
  Step 2: Add validation

Revert to step 0? (y/n)
```

#### `/revert to <sha>`
Reverts to a specific commit SHA:
- Finds the commit with matching SHA in snapshots.json
- Refuses if SHA is not in session's history
- Shows commits that will be discarded
- Requires confirmation

#### `/revert list`
Lists all commits for the active session:
- Shows step index, description, SHA, and timestamp
- Useful for identifying revert targets

Example:
```
Session commits:

  Step 0: Create project structure
    SHA: abc123...
    Time: 7/5/2026, 1:00:00 PM
  Step 1: Implement login form
    SHA: def456...
    Time: 7/5/2026, 1:30:00 PM
```

#### `/revert diff`
Shows the changes in the last commit:
- Displays file statistics and changes
- Useful for reviewing what was done before reverting

Example:
```
Changes in last commit:

 src/login.tsx | 10 +++++-----
 1 file changed, 5 insertions(+), 5 deletions(-)
```

#### `/revert diff <n>`
Shows the changes in a specific step:
- Finds the commit for step `n` in snapshots.json
- Displays the diff for that commit
- Refuses if step `n` is not in session's history

Example:
```
/revert diff 1
Changes for commit def4567a:

 src/login.tsx | 20 +++++++++++++++++++-
 1 file changed, 19 insertions(+), 1 deletion(-)
```

#### `/revert diff <sha>`
Shows the changes in a specific commit:
- Finds the commit with matching SHA (can use partial SHA)
- Displays the diff for that commit
- Refuses if SHA is not in session's history

Example:
```
/revert diff abc123
Changes for commit abc1234b:

 src/auth.tsx | 15 +++++++++++++++
 1 file changed, 15 insertions(+)
```

### Safety Guarantees

1. **Session Isolation**: Each session has its own branch; commits never leak between sessions
2. **Target Validation**: Revert refuses if target is not in the session's own commit history
3. **Confirmation Required**: Revert always shows what will be discarded and requires Y/n confirmation
4. **History Preservation**: `snapshots.json` keeps full history even after revert (entries are not removed)
5. **No Cross-Session Contamination**: All git commands are isolated in `git.ts` module

### Git Module Structure

All git operations are centralized in `src/git/git.ts`:

```typescript
// Basic git utilities
gitStatus()                    // git status --porcelain
gitGetCurrentBranch()          // git branch --show-current
gitGetCurrentCommit()          // git rev-parse HEAD
gitCreateBranch(name)          // git checkout -b <name>
gitCommit(message)             // git commit -m <message>
gitReset(target)               // git reset --hard <target>
gitGetCommitLog(branch)        // git log <branch> --format="%H %s"

// Session-specific operations
createSessionBranch(name)       // Creates zizou/<name> branch
createSessionCommit(id, step, desc)  // Commits with formatted message
listSessionCommits(id)         // Returns commits from snapshots.json
revertSession(id, target, confirm)  // Reverts with safety checks
```

## Integration Points

### Chat.tsx

- **On mount**: Loads active session state (conversation, tokens, pinned files)
- **After each turn**: Auto-saves session state to disk
- **Session switch**: Clears current state and loads new session's state

### Orchestrator

- **After verification**: Calls `createSessionCommit()` if verification succeeds
- **Both modes**: Commits happen in both build mode and plan mode
- **Error handling**: Commit failures are logged but don't fail the step

### Commands Module

- **Session commands**: `/session new/list/switch/delete`
- **Revert commands**: `/revert`, `/revert to <n|sha>`, `/revert list`
- **Async handling**: `handleSlashCommand` is async to support revert operations

## Usage Example

```bash
# Start Zizou
bun run src/cli.tsx

# Create a new session for login feature
/session new login-feature

# Work on login feature...
[Make changes, run steps]

# Create another session for auth feature
/session switch auth-feature
[Blocked if working tree dirty - commit first]
git commit -am "WIP login"
/session switch auth-feature

# Work on auth feature...
[Make changes, run steps]

# List commits
/revert list

# Revert to step 0
/revert to 0

# Switch back to login session
/session switch login-feature

# Delete auth session when done
/session delete auth-feature
[Git branch zizou/auth-feature remains for manual cleanup]
```

## Architecture Decisions

1. **Git Branch per Session**: Provides clean isolation and enables easy diff/merge between sessions
2. **Snapshots.json**: Maps step indices to commits, enabling revert by step number
3. **Archive Instead of Delete**: Safer than hard-deleting; allows recovery if needed
4. **Manual Branch Cleanup**: Git branch deletion is destructive; leaving it to user is safer
5. **Centralized Git Module**: Prevents git commands from spreading across codebase
6. **Auto-Save After Each Turn**: Ensures state is never lost
7. **Working Tree Check**: Prevents accidental data loss when switching sessions

## Future Enhancements

Potential improvements not yet implemented:
- Branch-per-session with automatic cleanup
- Merge sessions functionality
- Session templates
- Export/import sessions
- Visual diff between sessions
- Session sharing between users
