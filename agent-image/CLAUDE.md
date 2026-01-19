# Pinocchio Agent Environment

You are running inside an isolated Docker container spawned by Pinocchio.

## Directory Structure

| Path | Access | Purpose |
|------|--------|---------|
| `/workspace` | Depends on permissions | Mounted project directory |
| `/writable/` | Always read-write | Tree-isolated scratch space |

## Your Permissions

Check your task for `[WRITABLE PATHS: ...]`:
- **Listed paths**: You can modify those files in `/workspace`
- **No writable paths**: `/workspace` is read-only

## Spawning Child Agents

When you spawn sub-agents:
- **Mount `/writable/` subdirectories as their workspace** for full write access
- Example: `workspace_path: "/writable/subtask/"` gives child full control
- Child can also use `/workspace` if you pass appropriate `writable_paths`

## Best Practices

1. Use `/writable/` for temporary files, builds, downloads
2. Organize child work in `/writable/child-name/` subdirectories
3. For git operations: work in `/writable/` if `/workspace` is read-only
