// A named set of other objects, addressed like one of them.
//
// `/drums gain=0.5 at=cycle` where "drums" is a group runs that exact command
// against every member — so the four drum tracks fade together, on the same
// boundary, from one line. That is the whole idea: a group holds no audio and
// no state of its own, it is a *dispatch* target (see commands.js's
// groupCommand, which strips the few keys below and forwards everything else
// verbatim to each member's own command handler).
//
// Deliberately not a bus. A bus is a real channel — it sums signal, and
// routing four tracks into one is a mixing decision that changes what you
// hear (one fader, one insert chain, one pan). A group changes nothing about
// the graph; it addresses several objects at once and leaves each of them
// exactly as independent as it was. The two compose: a group of the four
// tracks that already send to a drum bus is the normal arrangement.
//
// Members are stored as **names**, not object references, and are resolved
// fresh on every command. That's what lets a group be written down before its
// members exist (session load order), survive a member being torn down and
// recreated (`/recall` does exactly this), and be serialized as-is. The cost
// is that a member removed for good leaves its name behind, reported as
// "(missing)" by the summary rather than silently disappearing.
// Whatever a command or a session file hands over — a comma-separated string
// ("kick,snare,hats", the only list form a console value token can carry,
// having no spaces) or an array — as a de-duplicated list of names, order
// preserved. Exported because the console needs to normalize a `members=`
// value *before* it can validate the names in it, which happens before the
// group is told anything (see commands.js's groupCommand).
export function normalizeMembers(members) {
    const list = Array.isArray(members) ? members : String(members ?? "").split(",");
    return [...new Set(list.map((name) => String(name).trim()).filter(Boolean))];
};

export class RibbitGroup {
    constructor({ name = "group", members = [] } = {}) {
        this.llm_summary = "A named set of objects — every command sent to the group is run against each member.";
        this.name = name;
        this.members = [];
        this.setMembers(members);
    };

    setMembers(members) {
        this.members = normalizeMembers(members);
        return this.members;
    };

    has(name) {
        return this.members.includes(name);
    };

    add(name) {
        if (this.has(name)) return false;
        this.members.push(name);
        return true;
    };

    remove(name) {
        const index = this.members.indexOf(name);
        if (index === -1) return false;
        this.members.splice(index, 1);
        return true;
    };
};
