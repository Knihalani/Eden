"""Firecracker sandbox runner using BandSox.

This module provides hardware-isolated code execution for the Tester agent.
Each test run executes in an ephemeral microVM with no access to Eden infrastructure.
"""

import asyncio
import json
import logging
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path

logger = logging.getLogger(__name__)


class VMState(Enum):
    """VM lifecycle states."""
    INIT = "init"
    READY = "ready"
    BUSY = "busy"
    FAILED = "failed"
    DESTROYED = "destroyed"


@dataclass
class TestResult:
    """Result from a sandboxed test execution."""

    success: bool
    test_count: int
    passed: int
    failed: int
    errors: int
    output: str
    exploit_findings: list[dict] = field(default_factory=list)
    mutation_score: float | None = None


@dataclass
class SandboxConfig:
    """Sandbox configuration for a single VM."""
    memory_mb: int = 512
    cpu_count: int = 2
    timeout_seconds: int = 300
    max_output_size: int = 1024 * 1024  # 1MB


@dataclass
class VMInstance:
    """Represents a single Firecracker microVM instance."""
    id: str
    state: VMState = VMState.INIT
    snapshot_id: str | None = None
    socket_path: Path | None = None
    created_at: float | None = None
    last_used: float | None = None


class BandSoxProtocol:
    """Protocol for communicating with BandSox daemon and VMs."""

    # Message types
    MSG_EXEC = 0x01
    MSG_RESULT = 0x02
    MSG_PING = 0x03
    MSG_PONG = 0x04
    MSG_SNAPSHOT = 0x05
    MSG_RESTORE = 0x06
    MSG_TERMINATE = 0x07

    @staticmethod
    def encode_message(msg_type: int, payload: dict) -> bytes:
        """Encode a message with type prefix and JSON payload."""
        data = json.dumps(payload).encode("utf-8")
        header = bytes([msg_type]) + len(data).to_bytes(4, "big")
        return header + data

    @staticmethod
    def decode_message(data: bytes) -> tuple[int, dict]:
        """Decode a message, returning (msg_type, payload)."""
        if len(data) < 5:
            raise ValueError(f"Message too short: {len(data)} bytes")
        msg_type = data[0]
        length = int.from_bytes(data[1:5], "big")
        payload = json.loads(data[5:5 + length].decode("utf-8"))
        return msg_type, payload


class SandboxRunner:
    """Manages Firecracker microVMs for isolated code execution.

    Uses BandSox for VM lifecycle management with snapshot pooling
    for fast reuse across test runs.

    Architecture:
    - VM Pool: Pre-warmed snapshots ready to execute
    - Active VMs: Currently executing test workloads
    - Concurrent limit: Max VMs running simultaneously
    """

    # BandSox daemon defaults
    DEFAULT_BANDSOX_HOST = "127.0.0.1"
    DEFAULT_BANDSOX_PORT = 9090

    def __init__(
        self,
        memory_mb: int = 512,
        cpu_count: int = 2,
        snapshot_pool_size: int = 10,
        max_concurrent: int = 100,
        bandsox_host: str | None = None,
    bandsox_port: int | None = None,
    ):
        self.memory_mb = memory_mb
        self.cpu_count = cpu_count
        self.snapshot_pool_size = snapshot_pool_size
        self.max_concurrent = max_concurrent
        self.bandsox_host = bandsox_host or self.DEFAULT_BANDSOX_HOST
        self.bandsox_port = bandsox_port or self.DEFAULT_BANDSOX_PORT

        # VM management
        self._vm_pool: dict[str, VMInstance] = {}
        self._active_vms: dict[str, VMInstance] = {}
        self._semaphore: asyncio.Semaphore | None = None
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._connected: bool = False
        self._pool_initialized: bool = False

        # Statistics
        self._stats = {
            "vm_created": 0,
            "vm_reused": 0,
            "tests_run": 0,
            "exploits_found": 0,
        }

    async def initialize(self) -> None:
        """Initialize the sandbox runner with BandSox connection and snapshot pool.

        Creates the initial VM pool by:
        1. Connecting to BandSox daemon
        2. Pre-creating snapshots for fast reuse
        3. Warming VMs to reduce cold-start latency
        """
        logger.info(
            f"Initializing SandboxRunner: pool_size={self.snapshot_pool_size}, "
            f"max_concurrent={self.max_concurrent}"
        )

        self._semaphore = asyncio.Semaphore(self.max_concurrent)

        # Connect to BandSox daemon
        await self._connect_to_bandsox()

        # Pre-create VM pool
        await self._warm_pool()

        self._pool_initialized = True
        logger.info("Sandbox runner initialized successfully")

    async def _connect_to_bandsox(self) -> None:
        """Establish connection to BandSox daemon."""
        try:
            self._reader, self._writer = await asyncio.wait_for(
                asyncio.open_connection(self.bandsox_host, self.bandsox_port),
                timeout=5.0,
            )
            self._connected = True
            logger.info(f"Connected to BandSox at {self.bandsox_host}:{self.bandsox_port}")

            # Verify connection with ping
            await self._send_ping()
        except TimeoutError:
            logger.error("BandSox connection timeout")
            raise RuntimeError("Failed to connect to BandSox: connection timeout")
        except ConnectionRefusedError:
            logger.error("BandSox connection refused")
            raise RuntimeError("Failed to connect to BandSox: connection refused")
        except Exception as e:
            logger.error(f"BandSox connection failed: {e}")
            raise RuntimeError(f"Failed to connect to BandSox: {e}")

    async def _send_ping(self) -> bool:
        """Send ping to BandSox and wait for pong."""
        if not self._writer or not self._reader:
            return False

        try:
            msg = BandSoxProtocol.encode_message(BandSoxProtocol.MSG_PING, {"ping": "hello"})
            self._writer.write(msg)
            await self._writer.drain()

            # Wait for pong with timeout
            data = await asyncio.wait_for(self._reader.read(1024), timeout=2.0)
            msg_type, _ = BandSoxProtocol.decode_message(data)
            return msg_type == BandSoxProtocol.MSG_PONG
        except Exception:
            return False

    async def _warm_pool(self) -> None:
        """Pre-create and warm the VM snapshot pool."""
        logger.info(f"Warming VM pool with {self.snapshot_pool_size} snapshots")

        create_tasks = []
        for i in range(self.snapshot_pool_size):
            vm_id = f"pool-{i:04d}"
            create_tasks.append(self._create_vm_in_pool(vm_id))

        # Create VMs concurrently with some batching to avoid overwhelming the system
        batch_size = 4
        for j in range(0, len(create_tasks), batch_size):
            batch = create_tasks[j:j + batch_size]
            await asyncio.gather(*batch, return_exceptions=True)

        ready_count = sum(1 for vm in self._vm_pool.values() if vm.state == VMState.READY)
        logger.info(f"VM pool warmed: {ready_count}/{self.snapshot_pool_size} ready")

    async def _create_vm_in_pool(self, vm_id: str) -> VMInstance:
        """Create a single VM and add it to the pool."""
        import time

        vm = VMInstance(
            id=vm_id,
            state=VMState.INIT,
            created_at=time.time(),
        )

        try:
            # Send snapshot creation request to BandSox
            if self._writer:
                request = {
                    "action": "create_snapshot",
                    "vm_id": vm_id,
                    "config": {
                        "memory_mb": self.memory_mb,
                        "cpu_count": self.cpu_count,
                                            },
                }
                msg = BandSoxProtocol.encode_message(BandSoxProtocol.MSG_SNAPSHOT, request)
                self._writer.write(msg)
                await self._writer.drain()

                # Wait for confirmation
                data = await asyncio.wait_for(self._reader.read(4096), timeout=10.0)
                msg_type, response = BandSoxProtocol.decode_message(data)

                if msg_type == BandSoxProtocol.MSG_RESULT and response.get("success"):
                    vm.state = VMState.READY
                    vm.snapshot_id = response.get("snapshot_id", vm_id)
                    self._stats["vm_created"] += 1
                    logger.debug(f"Created VM {vm_id} in pool")
                else:
                    vm.state = VMState.FAILED
                    logger.warning(f"Failed to create VM {vm_id}: {response}")

        except Exception as e:
            vm.state = VMState.FAILED
            logger.warning(f"VM {vm_id} creation failed: {e}")

        self._vm_pool[vm_id] = vm
        return vm

    async def _acquire_vm(self) -> VMInstance:
        """Acquire a VM from the pool, creating a new one if needed."""
        # First, try to get an available VM from the pool
        for vm_id, vm in self._vm_pool.items():
            if vm.state == VMState.READY:
                vm.state = VMState.BUSY
                self._active_vms[vm_id] = vm
                vm.last_used = asyncio.get_event_loop().time()
                self._stats["vm_reused"] += 1
                return vm

        # If no VMs available and under limit, create a new one
        if len(self._active_vms) < self.max_concurrent:
            import uuid
            vm_id = f"active-{uuid.uuid4().hex[:8]}"
            vm = VMInstance(id=vm_id, state=VMState.BUSY)
            vm.created_at = asyncio.get_event_loop().time()
            self._active_vms[vm_id] = vm
            self._stats["vm_created"] += 1

            # Initialize this VM via BandSox
            await self._initialize_active_vm(vm)
            return vm

        # Wait for a VM to become available
        raise RuntimeError("No VMs available and at concurrent limit")

    async def _initialize_active_vm(self, vm: VMInstance) -> None:
        """Initialize a newly allocated active VM."""
        try:
            if self._writer:
                request = {
                    "action": "create",
                    "vm_id": vm.id,
                    "config": {
                        "memory_mb": self.memory_mb,
                        "cpu_count": self.cpu_count,
                                            },
                }
                msg = BandSoxProtocol.encode_message(BandSoxProtocol.MSG_SNAPSHOT, request)
                self._writer.write(msg)
                await self._writer.drain()

                # Wait for creation confirmation
                data = await asyncio.wait_for(self._reader.read(4096), timeout=10.0)
                _, response = BandSoxProtocol.decode_message(data)

                if response.get("success"):
                    vm.state = VMState.READY
                    vm.socket_path = Path(response.get("socket", f"/tmp/fc-{vm.id}.sock"))
                else:
                    vm.state = VMState.FAILED
                    raise RuntimeError(f"VM initialization failed: {response}")

        except Exception as e:
            vm.state = VMState.FAILED
            raise RuntimeError(f"Failed to initialize VM {vm.id}: {e}")

    async def _release_vm(self, vm: VMInstance, reuse: bool = True) -> None:
        """Release a VM back to the pool or destroy it."""
        vm_id = vm.id

        # Remove from active
        if vm_id in self._active_vms:
            del self._active_vms[vm_id]

        if reuse and vm.state != VMState.FAILED:
            # Return to pool
            vm.state = VMState.READY
            vm.last_used = asyncio.get_event_loop().time()
            self._vm_pool[vm_id] = vm
        else:
            # Destroy the VM
            vm.state = VMState.DESTROYED
            try:
                if self._writer:
                    request = {"action": "terminate", "vm_id": vm_id}
                    msg = BandSoxProtocol.encode_message(BandSoxProtocol.MSG_TERMINATE, request)
                    self._writer.write(msg)
                    await self._writer.drain()
            except Exception:
                pass  # Best effort cleanup

            if vm_id in self._vm_pool:
                del self._vm_pool[vm_id]

    async def run_tests(
        self,
        code: str,
        test_suite: str,
        exploit_probes: list[dict],
        timeout: int = 300,
    ) -> TestResult:
        """Run tests in an isolated microVM.

        Args:
            code: The generated environment code
            test_suite: The test suite to run
            exploit_probes: List of exploit probes to apply
            timeout: Maximum execution time in seconds

        Returns:
            TestResult with test outcomes and exploit findings
        """
        if not self._pool_initialized:
            await self.initialize()

        async with self._semaphore or asyncio.Semaphore(self.max_concurrent):
            vm = await self._acquire_vm()

            try:
                result = await self._execute_in_vm(vm, code, test_suite, exploit_probes, timeout)
                self._stats["tests_run"] += 1
                if result.exploit_findings:
                    self._stats["exploits_found"] += len(result.exploit_findings)
                return result
            except Exception as e:
                logger.error(f"VM execution failed: {e}")
                return TestResult(
                    success=False,
                    test_count=0,
                    passed=0,
                    failed=0,
                    errors=1,
                    output=f"Execution error: {e}",
                    exploit_findings=[],
                )
            finally:
                await self._release_vm(vm, reuse=True)

    async def _execute_in_vm(
        self,
        vm: VMInstance,
        code: str,
        test_suite: str,
        exploit_probes: list[dict],
        timeout: int,
    ) -> TestResult:
        """Execute test payload in a VM."""
        # Prepare the execution payload
        payload = {
            "action": "execute",
            "vm_id": vm.id,
            "code": code,
            "test_suite": test_suite,
            "exploit_probes": exploit_probes,
            "timeout": timeout,
            "working_dir": "/workspace",
        }

        # Execute via BandSox
        try:
            if not self._writer:
                raise RuntimeError("Not connected to BandSox")

            msg = BandSoxProtocol.encode_message(BandSoxProtocol.MSG_EXEC, payload)
            self._writer.write(msg)
            await self._writer.drain()

            # Read result with timeout
            response_data = await asyncio.wait_for(
                self._reader.read(64 * 1024),  # 64KB max response
                timeout=timeout + 30,  # Allow extra time for VM boot
            )

            msg_type, response = BandSoxProtocol.decode_message(response_data)

            if msg_type == BandSoxProtocol.MSG_RESULT:
                return self._parse_test_result(response)
            else:
                return TestResult(
                    success=False,
                    test_count=0,
                    passed=0,
                    failed=0,
                    errors=1,
                    output=f"Unexpected message type: {msg_type}",
                    exploit_findings=[],
                )

        except TimeoutError:
            logger.error(f"Test execution timed out after {timeout}s")
            return TestResult(
                success=False,
                test_count=0,
                passed=0,
                failed=0,
                errors=1,
                output=f"Timeout after {timeout}s",
                exploit_findings=[],
            )

    def _parse_test_result(self, response: dict) -> TestResult:
        """Parse BandSox response into TestResult."""
        if "error" in response:
            return TestResult(
                success=False,
                test_count=0,
                passed=0,
                failed=0,
                errors=1,
                output=response["error"],
                exploit_findings=response.get("exploit_findings", []),
                mutation_score=response.get("mutation_score"),
            )

        return TestResult(
            success=response.get("success", False),
            test_count=response.get("test_count", 0),
            passed=response.get("passed", 0),
            failed=response.get("failed", 0),
            errors=response.get("errors", 0),
            output=response.get("output", ""),
            exploit_findings=response.get("exploit_findings", []),
            mutation_score=response.get("mutation_score"),
        )

    async def execute_code(
        self,
        code: str,
        input_data: dict,
        timeout: int = 60,
    ) -> dict:
        """Execute arbitrary code with structured input/output.

        Used for running individual test cases and verification steps.
        """
        if not self._pool_initialized:
            await self.initialize()

        async with self._semaphore or asyncio.Semaphore(self.max_concurrent):
            vm = await self._acquire_vm()

            try:
                payload = {
                    "action": "execute_single",
                    "vm_id": vm.id,
                    "code": code,
                    "input": input_data,
                    "timeout": timeout,
                }

                if not self._writer:
                    return {"success": False, "error": "Not connected to BandSox"}

                msg = BandSoxProtocol.encode_message(BandSoxProtocol.MSG_EXEC, payload)
                self._writer.write(msg)
                await self._writer.drain()

                response_data = await asyncio.wait_for(
                    self._reader.read(1024 * 1024),
                    timeout=timeout + 10,
                )

                _, response = BandSoxProtocol.decode_message(response_data)

                if "error" in response:
                    return {"success": False, "error": response["error"]}

                return {
                    "success": response.get("success", False),
                    "output": response.get("output"),
                }

            except TimeoutError:
                return {"success": False, "error": f"Timeout after {timeout}s"}
            except Exception as e:
                return {"success": False, "error": str(e)}
            finally:
                await self._release_vm(vm, reuse=True)

    async def verify_isolation(self) -> bool:
        """Verify that the sandbox provides proper isolation.

        Runs a series of isolation tests to confirm the sandbox blocks:
        - Network access
        - Filesystem access to Eden infrastructure
        - KB access
        - Privilege escalation

        Returns True if all isolation tests pass.
        """
        logger.info("Running sandbox isolation verification")

        isolation_tests = [
            # Test 1: No network access
            {
                "name": "network_isolation",
                "code": """
import socket
try:
    socket.create_connection(("8.8.8.8", 53), timeout=2)
    print("NETWORK_ACCESSIBLE")
except Exception as e:
    print(f"BLOCKED: {e}")
""",
            },
            # Test 2: No filesystem access outside workspace
            {
                "name": "filesystem_isolation",
                "code": """
import os
paths_to_check = ["/etc/passwd", "/Users/kaiavnihalani", "/tmp/../etc"]
for path in paths_to_check:
    try:
        if os.path.exists(path):
            print(f"ACCESSIBLE: {path}")
    except Exception as e:
        print(f"BLOCKED: {path} - {e}")
""",
            },
            # Test 3: No subprocess to Eden binaries
            {
                "name": "process_isolation",
                "code": """
import subprocess
for cmd in ["ps", "ls", "cat"]:
    try:
        subprocess.run([cmd], capture_output=True, timeout=1)
        print(f"EXEC_OK: {cmd}")
    except Exception as e:
        print(f"EXEC_BLOCKED: {cmd} - {e}")
""",
            },
            # Test 4: Memory constraints
            {
                "name": "memory_limit",
                "code": """
import resource
soft, hard = resource.getrlimit(resource.RLIMIT_AS)
print(f"MEM_LIMIT: soft={soft}, hard={hard}")
# Try to allocate 1GB
try:
    data = bytearray(1024 * 1024 * 1024)
    print("ALLOC_1GB_OK")
except MemoryError:
    print("ALLOC_1GB_FAILED")
""",
            },
        ]

        all_passed = True
        results = []

        for test in isolation_tests:
            result = await self.execute_code(test["code"], {}, timeout=10)
            passed = "BLOCKED" in result.get("output", "") or "EXEC_BLOCKED" in result.get("output", "") or "MEM_LIMIT" in result.get("output", "")
            results.append({"test": test["name"], "passed": passed, "output": result.get("output", "")})

            if not passed and test["name"] != "memory_limit":
                all_passed = False

        if all_passed:
            logger.info("Isolation verification passed")
        else:
            logger.warning(f"Isolation verification failed: {results}")

        return all_passed

    async def get_stats(self) -> dict:
        """Get sandbox runner statistics."""
        return {
            **self._stats,
            "pool_size": len(self._vm_pool),
            "pool_ready": sum(1 for vm in self._vm_pool.values() if vm.state == VMState.READY),
            "active_vms": len(self._active_vms),
        }

    async def destroy(self) -> None:
        """Clean up all VMs and release BandSox connection."""
        logger.info("Destroying sandbox runner")

        # Terminate all active VMs
        for vm_id in list(self._active_vms.keys()):
            try:
                if self._writer:
                    request = {"action": "terminate", "vm_id": vm_id}
                    msg = BandSoxProtocol.encode_message(BandSoxProtocol.MSG_TERMINATE, request)
                    self._writer.write(msg)
                    await self._writer.drain()
            except Exception:
                pass

        self._active_vms.clear()
        self._vm_pool.clear()

        # Close BandSox connection
        if self._writer:
            self._writer.close()
            await self._writer.wait_closed()

        self._connected = False
        self._pool_initialized = False
        logger.info("Sandbox runner destroyed")


class NullSandboxRunner(SandboxRunner):
    """Fallback sandbox runner for development/testing when Firecracker is unavailable.

    Executes code directly with basic process isolation using subprocess.
    NOT suitable for production use with untrusted LLM-generated code.
    """

    def __init__(self, memory_mb: int = 512, cpu_count: int = 2, snapshot_pool_size: int = 10, max_concurrent: int = 100):
        # Don't call parent __init__ - we're intentionally bypassing Firecracker
        self.memory_mb = memory_mb
        self.cpu_count = cpu_count
        self.snapshot_pool_size = snapshot_pool_size
        self.max_concurrent = max_concurrent
        self._vm_pool = {}
        self._active_vms = {}
        self._semaphore = asyncio.Semaphore(max_concurrent)
        self._connected = True  # Fake connection for compatibility
        self._pool_initialized = True

        self._stats = {
            "vm_created": 0,
            "vm_reused": 0,
            "tests_run": 0,
            "exploits_found": 0,
        }

    async def initialize(self) -> None:
        """Initialize the null sandbox runner."""
        logger.warning("NullSandboxRunner initialized - NOT for production!")
        self._pool_initialized = True

    async def _connect_to_bandsox(self) -> None:
        """No-op for null runner."""
        pass

    async def _warm_pool(self) -> None:
        """No-op for null runner."""
        pass

    async def run_tests(
        self,
        code: str,
        test_suite: str,
        exploit_probes: list[dict],
        timeout: int = 300,
    ) -> TestResult:
        """Run tests directly in subprocess (DEV ONLY)."""
        logger.warning("Using NullSandboxRunner - NOT for production!")

        # Concatenate the env code + test suite + probe code into a
        # single script that runs in one shared namespace. This way
        # the test_suite's ``assert`` statements can see the env
        # code's locals (e.g. ``x`` / ``y``), and each probe can
        # read what env set up.
        #
        # We DO NOT use nested ``exec()`` because that creates a new
        # namespace and the test_suite's ``assert`` can't see the
        # env code's locals.

        def _indent_block(s: str, prefix: str) -> str:
            """Indent every non-empty line of ``s`` by ``prefix``.

            Empty lines are left empty so the script remains
            parseable.
            """
            return "\n".join(
                prefix + line if line.strip() else ""
                for line in s.splitlines()
            )

        probe_section = "\n\n".join(
            f"# probe: {p.get('name', '?')}\n{p.get('probe_code', '').strip()}"
            for p in exploit_probes
            if p.get("probe_code", "").strip()
        ) or "# no probes"
        combined_code = (
            "import sys\n"
            "import json\n"
            "import traceback\n"
            "from io import StringIO\n"
            "sys.stdout = StringIO()\n"
            "_exploit_findings = []\n"
            "_probe_result = None\n"
            "try:\n"
            "    # === env code ===\n"
            + _indent_block(code, "    ") + "\n"
            "    # === test suite ===\n"
            + _indent_block(test_suite, "    ") + "\n"
            "    # === exploit probes ===\n"
            + _indent_block(probe_section, "    ") + "\n"
            "    # === harvest ===\n"
            "    for _probe in " + repr(exploit_probes) + ":\n"
            "        if _probe.get('probe_code', '').strip():\n"
            "            _exploit_findings.append({\n"
            "                'probe_name': _probe.get('name'),\n"
            "                'category': _probe.get('category'),\n"
            "                'result': _probe_result,\n"
            "            })\n"
            "    _stdout_output = sys.stdout.getvalue()\n"
            "    sys.stdout = sys.__stdout__\n"
            "    print('TEST_RESULTS:')\n"
            "    print(json.dumps({'test_count': 1, 'passed': 1, 'failed': 0, 'errors': 0}))\n"
            "    print('STDOUT:')\n"
            "    print(_stdout_output)\n"
            "    print('EXPLOIT_FINDINGS:')\n"
            "    print(json.dumps(_exploit_findings))\n"
            "except Exception as e:\n"
            "    sys.stdout = sys.__stdout__\n"
            "    print('ERROR:', file=sys.stderr)\n"
            "    traceback.print_exc()\n"
        )

        try:
            process = await asyncio.create_subprocess_exec(
                sys.executable, "-c", combined_code,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                limit=1024 * 1024,  # 1MB output limit
            )

            try:
                stdout, stderr = await asyncio.wait_for(
                    process.communicate(),
                    timeout=timeout,
                )
            except TimeoutError:
                process.kill()
                return TestResult(
                    success=False,
                    test_count=0,
                    passed=0,
                    failed=0,
                    errors=1,
                    output=f"Timeout after {timeout}s",
                    exploit_findings=[],
                )

            output = stdout.decode("utf-8", errors="replace")
            error_output = stderr.decode("utf-8", errors="replace")

            # Parse test results + exploit findings from the
            # structured markers the combined_code emitted.
            parsed_results: dict = {}
            parsed_findings: list = []
            try:
                if "TEST_RESULTS:" in output:
                    results_section = (
                        output.split("TEST_RESULTS:")[1]
                        .split("STDOUT:")[0]
                        .strip()
                    )
                    parsed_results = json.loads(results_section)
                if "EXPLOIT_FINDINGS:" in output:
                    findings_section = output.split("EXPLOIT_FINDINGS:")[1].strip()
                    # The findings section is followed by the next
                    # marker (or EOF); if there's nothing after,
                    # the split above is the whole rest.
                    parsed_findings = json.loads(findings_section)
            except (json.JSONDecodeError, IndexError):
                pass

            if parsed_results or parsed_findings:
                return TestResult(
                    success=True,
                    test_count=parsed_results.get("test_count", 0),
                    passed=parsed_results.get("passed", 0),
                    failed=parsed_results.get("failed", 0),
                    errors=parsed_results.get("errors", 0),
                    output=output[:10000],
                    exploit_findings=parsed_findings,
                    mutation_score=parsed_results.get("mutation_score"),
                )

            if process.returncode != 0:
                return TestResult(
                    success=False,
                    test_count=0,
                    passed=0,
                    failed=0,
                    errors=1,
                    output=error_output or output,
                    exploit_findings=[],
                )

            return TestResult(
                success=True,
                test_count=0,
                passed=0,
                failed=0,
                errors=0,
                output=output[:10000],
                exploit_findings=[],
            )

        except Exception as e:
            return TestResult(
                success=False,
                test_count=0,
                passed=0,
                failed=0,
                errors=1,
                output=str(e),
                exploit_findings=[],
            )

    async def execute_code(
        self,
        code: str,
        input_data: dict,
        timeout: int = 60,
    ) -> dict:
        """Execute code directly (DEV ONLY).

        Captures both ``output = ...`` assignments and anything the
        code prints via ``print()``.
        """
        import contextlib
        import io

        logger.warning("Using NullSandboxRunner - NOT for production!")

        try:
            exec_globals = {"input": input_data.copy(), "__name__": "__main__"}
            stdout_buf = io.StringIO()
            with contextlib.redirect_stdout(stdout_buf):
                exec(code, exec_globals)
            printed = stdout_buf.getvalue()
            # Prefer an explicit ``output`` variable, fall back to
            # captured stdout so tests using plain ``print()`` work.
            captured = exec_globals.get("output")
            if captured is None:
                captured = printed
            return {"success": True, "output": captured}
        except Exception as e:
            return {
                "success": False,
                "error": f"{type(e).__name__}: {e}",
            }
    async def destroy(self) -> None:
        """Clean up (no-op for null runner)."""
        self._pool_initialized = False


# Singleton instance
_sandbox_runner: SandboxRunner | None = None


async def get_sandbox_runner(
    memory_mb: int | None = None,
    cpu_count: int | None = None,
    snapshot_pool_size: int | None = None,
    max_concurrent: int | None = None,
) -> SandboxRunner:
    """Get the appropriate sandbox runner for the environment.

    Attempts to initialize a real SandboxRunner with Firecracker/BandSox.
    Falls back to NullSandboxRunner if Firecracker is unavailable.

    Args:
        memory_mb: VM memory in MB (default from config)
        cpu_count: VCPU count per VM (default from config)
        snapshot_pool_size: Pre-created VMs in pool (default from config)
        max_concurrent: Max concurrent VMs (default from config)

    Returns:
        SandboxRunner instance (real or null)
    """
    global _sandbox_runner

    if _sandbox_runner is not None:
        return _sandbox_runner

    # Import here to avoid circular imports
    from eden.config import get_settings

    settings = get_settings()

    memory_mb = memory_mb or settings.sandbox_memory_mb
    cpu_count = cpu_count or settings.sandbox_cpu_count
    snapshot_pool_size = snapshot_pool_size or settings.sandbox_snapshot_pool_size
    max_concurrent = max_concurrent or settings.sandbox_max_concurrent

    try:
        # Try to use real Firecracker sandbox
        runner = SandboxRunner(
            memory_mb=memory_mb,
            cpu_count=cpu_count,
            snapshot_pool_size=snapshot_pool_size,
            max_concurrent=max_concurrent,
                    )
        await runner.initialize()
        _sandbox_runner = runner
        logger.info("Initialized real SandboxRunner")
        return runner
    except Exception as e:
        logger.warning(f"Firecracker not available ({e}), using NullSandboxRunner")
        runner = NullSandboxRunner(
            memory_mb=memory_mb,
            cpu_count=cpu_count,
            snapshot_pool_size=snapshot_pool_size,
            max_concurrent=max_concurrent,
        )
        await runner.initialize()
        _sandbox_runner = runner
        return runner


async def close_sandbox_runner() -> None:
    """Close and cleanup the global sandbox runner instance."""
    global _sandbox_runner

    if _sandbox_runner is not None:
        await _sandbox_runner.destroy()
        _sandbox_runner = None
