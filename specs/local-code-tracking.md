# Local Code Tracking System Specification

## Overview

The Local Code Tracking System provides an internal checkpoint mechanism for tracking AI-generated changes independently of Git. It enables users to create, restore, and branch from checkpoints representing individual AI operations, without affecting the user's Git workflow.

## Core Principles

- **Atomic Checkpoints**: Each checkpoint represents one atomic AI-generated change (one prompt execution)
- **Incremental Storage**: Stores only incremental diff patches for changed files
- **Git Independence**: Operates independently of the user's Git repository
- **Persistence**: Checkpoints persist across application restarts
- **Branching Support**: Full support for creating and switching between parallel checkpoint branches
- **Automatic Creation**: Checkpoints are created automatically after each successful AI operation

## Architecture

### Module Structure

```
src/checkpoint/
├── types.ts      # Data structures (Checkpoint, FilePatch, CheckpointBranch, etc.)
├── storage.ts    # Persistence layer (load/save checkpoint history)
├── patcher.ts    # File state capture and restoration utilities
└── manager.ts    # Checkpoint lifecycle management (create, restore, branch, etc.)
```

### Data Structures

#### Checkpoint

```typescript
interface Checkpoint {
  id: string;                    // UUID
  parentId: string | null;       // Parent checkpoint (null for root)
  branchId: string;              // Branch identifier
  stepIndex: number;             // Step number in branch
  description: string;           // Step description
  timestamp: string;             // ISO timestamp
  patches: FilePatch[];          // Incremental diffs for changed files
}
```

#### FilePatch

```typescript
interface FilePatch {
  filePath: string;             // Relative path from project root
  operation: "create" | "modify" | "delete";
  oldContent: string | null;     // Content before change (null for create)
  newContent: string | null;     // Content after change (null for delete)
}
```

#### CheckpointBranch

```typescript
interface CheckpointBranch {
  id: string;                    // Branch ID
  name: string;                  // Branch name (e.g., "main", "feature-x")
  rootCheckpointId: string;      // First checkpoint in branch
  headCheckpointId: string;      // Current head of branch
  createdAt: string;             // ISO timestamp
}
```

#### CheckpointHistory

```typescript
interface CheckpointHistory {
  branches: CheckpointBranch[];
  checkpoints: Map<string, Checkpoint>;
  activeBranchId: string;       // Currently active branch
}
```

## Storage Format

### Directory Structure

```
~/.zizou/checkpoints/<project-hash>/
  history.json                    # CheckpointHistory (branches + checkpoint index)
```

### Project Hash

The project hash is used to isolate checkpoint histories per project:
- If in a Git repository: Uses the current Git commit SHA
- If not in a Git repository: Hashes the directory path

### JSON Format

```json
{
  "branches": [
    {
      "id": "uuid",
      "name": "main",
      "rootCheckpointId": "uuid",
      "headCheckpointId": "uuid",
      "createdAt": "2026-07-05T..."
    }
  ],
  "checkpoints": [
    {
      "id": "uuid",
      "parentId": null,
      "branchId": "uuid",
      "stepIndex": 0,
      "description": "Create login form",
      "timestamp": "2026-07-05T...",
      "patches": [
        {
          "filePath": "src/login.tsx",
          "operation": "create",
          "oldContent": null,
          "newContent": "..."
        }
      ]
    }
  ],
  "activeBranchId": "uuid"
}
```

## API

### Checkpoint Manager Functions

#### `createCheckpoint(description: string, changedFiles: string[], oldFileStates?: Map<string, string | null>): Checkpoint`

Creats a new checkpoint for the given file changes.

- Automatically determines the parent checkpoint based on the active branch
- Creates the "main" branch if no active branch exists
- Captures file states and creates diff patches
- Returns the created checkpoint

#### `restoreCheckpoint(checkpointId: string): void`

Restores the workspace to a specific checkpoint state.

- Applies all patches from the branch's root up to the target checkpoint
- Updates the active branch's head to the restored checkpoint
- Throws if checkpoint not found

#### `createBranch(name: string, fromCheckpointId: string): CheckpointBranch`

Creates a new branch from a specific checkpoint.

- Validates that branch name doesn't already exist
- Sets the branch's root and head to the specified checkpoint
- Switches to the new branch automatically
- Returns the created branch

#### `switchBranch(branchId: string): void`

Switches the active branch.

- Restores workspace to the branch's head checkpoint
- Updates the active branch pointer
- Throws if branch not found

#### `listCheckpoints(branchId?: string): Checkpoint[]`

Lists all checkpoints, optionally filtered by branch.

- Returns checkpoints sorted by timestamp
- If branchId is provided, only returns checkpoints from that branch

#### `listBranches(): CheckpointBranch[]`

Lists all branches.

- Returns all branches in the project

#### `getActiveBranch(): CheckpointBranch | null`

Gets the currently active branch.

- Returns the active branch or null if no branches exist

#### `diffCheckpoints(fromId: string, toId: string): FilePatch[]`

Compares two checkpoints and returns the diff patches.

- Returns patches from the target checkpoint
- Throws if either checkpoint not found

#### `deleteCheckpoint(checkpointId: string): void`

Deletes a checkpoint.

- Cannot delete branch heads or branch roots
- Throws if checkpoint is a branch head or root
- Throws if checkpoint not found

### Patcher Functions

#### `captureFileState(filePath: string): string | null`

Captures the current state of a file.

- Returns file content as string, or null if file doesn't exist

#### `restoreFileState(filePath: string, content: string | null): void`

Restores a file to a specific state.

- If content is null, deletes the file
- If content is a string, writes it to the file

#### `createFilePatch(filePath: string, oldContent: string | null, newContent: string | null): FilePatch`

Creates a FilePatch for a single file change.

- Determines operation type (create/modify/delete) based on content changes

#### `applyFilePatch(patch: FilePatch): void`

Applies a FilePatch to move the file to its new state.

- Restores the file to the patch's newContent

#### `revertFilePatch(patch: FilePatch): void`

Applies a FilePatch to restore the file to its old state.

- Restores the file to the patch's oldContent

### Storage Functions

#### `getCheckpointHistoryPath(): string`

Gets the checkpoint history file path for the current project.

#### `loadCheckpointHistory(): CheckpointHistory`

Loads checkpoint history from disk.

- Returns empty history if file doesn't exist

#### `saveCheckpointHistory(history: CheckpointHistory): void`

Saves checkpoint history to disk.

- Creates directory if it doesn't exist

## CLI Commands

### `/checkpoint list`

Lists all checkpoints with branch information.

**Output:**
```
Checkpoints:

  Step 0: Create login form
    ID: abc12345
    Branch: main [ACTIVE]
    Time: 7/5/2026, 2:00:00 PM
```

### `/checkpoint diff`

Shows changes in the last checkpoint.

**Output:**
```
Changes in checkpoint abc12345:

  create: src/login.tsx
  modify: src/auth.tsx
```

### `/checkpoint diff <id>`

Shows changes in a specific checkpoint.

**Example:** `/checkpoint diff abc12345`

### `/checkpoint diff <from> <to>`

Compares two checkpoints.

**Example:** `/checkpoint diff abc12345 def67890`

### `/checkpoint restore <id>`

Restores the workspace to a specific checkpoint.

**Example:** `/checkpoint restore abc12345`

**Output:**
```
Restored to checkpoint: Create login form
```

### `/checkpoint branch <name> [from-checkpoint-id]`

Creates a new branch from a checkpoint.

**Example:** `/checkpoint branch feature-x abc12345`

**Output:**
```
Created branch "feature-x" from checkpoint abc12345
```

### `/checkpoint switch <branch>`

Switches to a branch.

**Example:** `/checkpoint switch main`

**Output:**
```
Switched to branch "main"
```

### `/checkpoint delete <id>`

Deletes a checkpoint.

**Example:** `/checkpoint delete abc12345`

**Output:**
```
Deleted checkpoint: Create login form
```

## Integration Points

### Orchestrator Integration

The orchestrator creates checkpoints automatically after each successful verification:

**Build Mode:**
```typescript
// After verification succeeds
if (verification.verified) {
  const oldFileStates = new Map<string, string | null>();
  for (const file of stepResult.claimedFiles) {
    const absPath = resolve(context.projectRoot, file);
    const preSnapshot = preSnapshots.get(absPath);
    if (preSnapshot) {
      if (preSnapshot.mtimeMs !== null) {
        oldFileStates.set(file, captureFileState(file));
      } else {
        oldFileStates.set(file, null);
      }
    }
  }
  createCheckpoint(syntheticStep.description, stepResult.claimedFiles, oldFileStates);
}
```

**Plan Mode:**
Similar logic applied for each step in the plan.

### Chat.tsx Autocomplete

The UI provides autocomplete for checkpoint commands:

- `/checkpoint ` - Shows subcommands (list, diff, restore, branch, switch, delete)
- `/checkpoint restore ` - Shows available checkpoints
- `/checkpoint switch ` - Shows available branches

## Usage Examples

### Basic Workflow

1. **AI Operation**: User runs an AI operation that modifies files
2. **Automatic Checkpoint**: System automatically creates a checkpoint after successful verification
3. **List Checkpoints**: User runs `/checkpoint list` to see all checkpoints
4. **View Changes**: User runs `/checkpoint diff <id>` to see what changed in a checkpoint
5. **Restore**: User runs `/checkpoint restore <id>` to revert to a previous state

### Branching Workflow

1. **Create Branch**: User runs `/checkpoint branch feature-x` to create a new branch from current state
2. **Continue Work**: User continues working, creating new checkpoints on the new branch
3. **Switch Back**: User runs `/checkpoint switch main` to return to the main branch
4. **Merge**: User can manually merge changes by restoring checkpoints from different branches

## Safety Guarantees

- **No Git Pollution**: Checkpoints are stored separately from Git, never creating commits or branches in the user's repository
- **Atomic Operations**: Each checkpoint represents a single atomic change
- **Verification Required**: Checkpoints are only created after successful verification
- **Branch Isolation**: Branches are completely isolated; changes on one branch don't affect others
- **Deletion Protection**: Cannot delete branch heads or roots to prevent data loss

## Limitations

- **No Automatic Merging**: Branches must be merged manually by restoring checkpoints
- **Full Content Storage**: Currently stores full old/new content for each patch (can be optimized to use actual diff format)
- **No Conflict Resolution**: Restoring a checkpoint overwrites current state without conflict detection
- **Project-Scoped**: Checkpoints are scoped per project (based on project hash)

## Future Enhancements

- **Diff Format Optimization**: Use unified diff format to reduce storage space
- **Conflict Detection**: Warn when restoring would overwrite uncommitted changes
- **Merge Support**: Add automatic merge capabilities between branches
- **Checkpoint Metadata**: Add more metadata (e.g., execution time, model used, token count)
- **Garbage Collection**: Add automatic cleanup of old checkpoints
- **Remote Storage**: Support storing checkpoints in remote storage (e.g., S3)
