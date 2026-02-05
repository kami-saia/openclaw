---
name: docker
description: Manage Docker containers, images, and networks. Use when needing to isolate environments, run containerized applications, debug container issues, or manage Docker lifecycles (build, run, stop, rm, logs).
---

# Docker Skill

This skill provides guidance for interacting with the Docker CLI to manage containers and images.

## Environment Specifics (WSL)

**Executable:**
The native `docker` command is missing in this WSL environment. Use the Windows Docker CLI directly:
`"/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe"`

**Aliases:**
You may alias this in your shell for convenience:
`alias docker="/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe"`

## Core Commands

### Lifecycle

- **List running containers**: `docker ps`
- **List all containers**: `docker ps -a`
- **Run a container**: `docker run [OPTIONS] IMAGE [COMMAND] [ARG...]`
  - Interactive: `docker run -it ubuntu bash` (Requires PTY)
  - Detached: `docker run -d -p 8080:80 nginx`
  - Remove on exit: `docker run --rm alpine echo hello`
- **Stop**: `docker stop <container_id>`
- **Kill**: `docker kill <container_id>` (Use if stop hangs)
- **Remove container**: `docker rm <container_id>` (Use `-f` to force if running)

### Images

- **List images**: `docker images`
- **Build image**: `docker build -t <tag_name> .`
- **Remove image**: `docker rmi <image_id>`
- **Prune unused**: `docker system prune -a` (Caution: Removes all stopped containers and unused images)

### Inspection & Debugging

- **Logs**: `docker logs <container_id>` (Use `-f` to follow)
- **Inspect JSON**: `docker inspect <container_id>` (Deep config details)
- **Execute in container**: `docker exec -it <container_id> <command>`
  - Shell access: `docker exec -it <container_id> /bin/bash` (or `/bin/sh`)
- **Stats**: `docker stats` (Live CPU/Memory usage)

## OpenClaw Lab Testing

When testing OpenClaw inside Docker (`openclaw-lab`), you often need to inject authentication and configuration since the container starts fresh.

### 1. Auth Injection (Prevent API Crashes)

The gateway crashes if no API keys are present. Inject your host `auth-profiles.json`:

```bash
# Create target directory
docker exec openclaw-lab mkdir -p /home/node/.openclaw/agents/main/agent

# Inject file (pipe from host to container)
cat ~/.openclaw/agents/main/agent/auth-profiles.json | \
  "/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe" exec -i openclaw-lab sh -c 'cat > /home/node/.openclaw/agents/main/agent/auth-profiles.json'
```

### 2. Config Injection (Override Defaults)

To change models or provider settings (e.g., for blackhole testing):

```bash
# Inject openclaw.json
"/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe" exec -i openclaw-lab sh -c 'cat > /home/node/.openclaw/openclaw.json <<EOF
{
  "agents": {
    "defaults": {
      "model": { "primary": "openai/gpt-4o" }
    }
  },
  "models": {
    "providers": {
      "openai": {
        "baseUrl": "http://192.0.2.1:1234/v1",
        "apiKey": "sk-dummy-key",
        "models": [{ "id": "gpt-4o", "name": "Blackhole", "api": "openai-completions", "reasoning": false, "input": ["text"], "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }, "contextWindow": 128000, "maxTokens": 4096 }]
      }
    }
  }
}
EOF'
```

## Best Practices

### Cleanup

- Always clean up test containers to save disk space.
- Prefer `--rm` for one-off tasks: `docker run --rm ...`

### Networking

- **Host Networking**: Use `--net=host` if you need the container to share the host's network stack (Linux only).
- **Port Mapping**: Use `-p <host_port>:<container_port>` (e.g., `-p 8080:80`) to expose services.

### Volumes (Data Persistence)

- **Bind Mount**: Map a host directory to the container.
  - `-v /host/path:/container/path`
  - Example: `docker run -v $(pwd):/app node:18 npm install`

## Common Issues

- **Permission Denied**: Try `sudo docker ...` or ensure the user is in the `docker` group.
- **Connection Refused**: Check if the container is running (`docker ps`) and if ports are mapped correctly.
- **"exec format error"**: Architecture mismatch (e.g., running ARM image on x86).
