# Heavy slots

Limit heavy jobs, not agents. A worktree costs disk. A whole-project type check costs gigabytes of memory. Count the second kind.

## What is heavy

| Heavy: takes a slot | Light: runs freely |
|---|---|
| whole-project type check or build | lint or format on explicit files |
| the full test suite, a test run without file arguments | tests of the files you changed, up to about 20 files |
| a browser run, with its dev server or preview | git operations, reading logs |
| the release gate | writing code and briefs |

On the audited runner (12 cores, 31 GB) a type check added about 4.4 GB, a browser run with its server and other lanes reached 15.8 GB box-wide, and one test process alone reached 12.9 GB. Slots follow from that arithmetic: `slots = floor((RAM - headroom) / largest heavy job)`. With 31 GB, 4 GB of headroom and a 9 GB job, that gives 3.

## The script

[`scripts/heavy-slot.sh`](../scripts/heavy-slot.sh) is a POSIX shell wrapper. Copy it into the project.

```sh
SLOT_DIR=/var/tmp/slots SLOTS=3 RESERVED=1 sh scripts/heavy-slot.sh -- npm run typecheck
SLOT_DIR=/var/tmp/slots SLOTS=3 RESERVED=1 sh scripts/heavy-slot.sh -r -- npm run gate
```

- Builders and integrators call it without `-r`. They may use `SLOTS - RESERVED` slots.
- The release captain calls it with `-r` and may use all of them. One slot stays free for the release class, so a queue of builders cannot starve the gate.
- A caller that finds no free slot prints one waiting line and polls. Waiting is the intended outcome, not an error.
- The wrapper starts the command as the leader of its own process group and gives it no standard input. It uses job control where the shell has it, and `setsid` or `perl` where the shell cannot (a dash without a terminal, which is what `/bin/sh` is on Debian and Ubuntu). INT, TERM and HUP reach the whole group, with KILL after `GRACE` seconds (default 10), and the wrapper exits with 128 plus the signal number. When the command ends on its own, whatever it left running in the group is stopped the same way, with a warning, so do not wrap a launcher that is meant to leave a server running. The slot is freed only after the group is empty.
- A claim on slot N is the directory `slot-N.G`, and G only grows. Creating `slot-N.<latest + 1>` is the one atomic step that makes a job the owner. A job never deletes a claim, not even its own: it marks it `released`, and a later claim of that slot sweeps only claims that are stale and at least `RETAIN` minutes old (default 60). A listing of a directory cannot prove ownership, so the scheme avoids needing one: a number is reused only by a job that sat for more than `RETAIN` minutes between reading a slot and creating its claim, and that is the one assumption it makes. A job writes only inside its own claim.
- A claim is stale, and may be claimed over, when it is released, or when its wrapper is gone and nothing of its command's group is left. A wrapper killed with SIGKILL therefore keeps its slot until its command finishes, because that command still uses the memory the slot stands for. The command writes its own group id into the claim from inside the group, before it runs, and is not run at all if that write fails. A dead wrapper with no group on record might have died while its command was starting, so its claim keeps the slot for `START_WAIT` minutes (default 3) and is stale after that.
- A process that starts its own session leaves the group and is not tracked. Run such tools in the foreground. If a machine has none of job control, `setsid` and `perl`, the script says so and can stop only the command itself.
- One `SLOT_DIR` per machine. Slots do not coordinate across machines.

On Linux you can use `flock` instead of directories: open `slot-N.lock` on a file descriptor and take `flock -n` on each N in turn. The behavior is the same, and the kernel releases the lock when the process dies.

To skip a heavy command that already passed on the same tree, key a pass record by the tree id, the command and the runtime version, and write it only after a green run on a clean tree. That is the receipt idea from `verify-delivery`, applied per command.

## What happened without it

The runner logged 37 out-of-memory kills over three days. The victims were browser processes and node processes of 6 to 13 GB. Slots were introduced in steps: 16 lanes with 2 heavy slots for browser runs, then the same slots for type checks, the gate and the full suite. After the slots covered everything, the journal showed no further kills. The queue was long on the busiest day (346 "waiting for a heavy slot" lines in the tool output), and that was the price of a flat memory curve.

## Failure modes

- Counting lanes. Six lanes with four test workers each meant 24 forks on 12 cores. The limit belongs on the heavy command.
- Two lock sets on one box. A gate runner and a lane runner each had their own slots and no shared memory budget. Load reached 94 and SSH dropped until the gate slots were cut from 3 to 2. Give one machine one budget.
- Priority inversion. A release UAT waited 19 minutes for a slot at a load of 2.4, because lower-priority probes held the slots. This is why `RESERVED` exists.
- Orphans that keep a slot. Killing a browser-run script on the laptop left its container running on the runner, still holding a slot. The script stops local descendants of the command. A remote process is not one, so trap the exit, stop the remote process, and give every slot a maximum age.
- Idle lanes. Seven stale lanes with no processes blocked all 16 lane slots. Release lanes that are idle for more than two hours.
- Banning builders from heavy checks. The ban made them ship blind. See step 2 of the skill.

## The laptop is a one-job fallback

When the runner was unreachable, one hotfix ran the full gate on a laptop with nothing else in parallel. It passed in about 8 minutes and shipped. The same laptop (24 GB) had rebooted from memory pressure two days earlier, when parallel agents ran a dev server, a browser, a type check and tests at once. It lost the contents of its temp directory. Use a laptop for one heavy job at a time, and keep scratch outside the temp directory.

## Not exercised yet

A scheduler that admits a job only when free memory is at least the job's reservation plus headroom and the load is under 1.5 times the cores. The proposed classes were light 0.5 GB, medium 5 GB, heavy 9 GB and browser 4 GB, with priority release, then train, then builder. The slot script above approximates the priority with `RESERVED` and does not look at memory.
