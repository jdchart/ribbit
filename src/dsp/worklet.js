import { dspLibrary } from "./lib.js";

// AudioWorklet processors for the types whose DSP a node graph can't express.
//
// **Why worklets at all.** Web Audio forces every cycle in a node graph to
// contain a DelayNode of at least one render quantum (128 samples). That is
// the wall `karplus` and `comb` document: nothing in a graph can resonate
// above ~375Hz, and no effect can put a pitch shifter, a wavefolder or a
// freeze *inside* a feedback loop. `karplus`/`chaossynth`/`czsynth` answer it
// by rendering each note into a buffer, which works for a one-shot and not at
// all for an effect, a sustained voice, or a voice whose parameters should
// keep moving while it rings. A worklet runs arbitrary per-sample code on the
// audio thread, so all of those become ordinary code.
//
// **Why no file for the host to serve.** An AudioWorklet module is loaded by
// URL, and the engine's one rule about hosts is that it asks them for JSON
// manifests and nothing else. So — the technique recorder.js established for
// its capture processor — the module is compiled from source text into a blob
// URL. Each processor is written as a real function in a real module (so it
// is syntax-checked and readable), registered here, and turned into text with
// `Function.prototype.toString()`. That imposes the one discipline worth
// stating: **a processor factory must be self-contained** — it may use its
// two arguments (`Base`, the AudioWorkletProcessor class, and `DSP`, the
// toolkit from lib.js) and the worklet globals (`sampleRate`, `currentTime`),
// and nothing else from its module, because nothing else exists where it runs.
//
// **One module per context.** Every processor registered by the time the
// first type is constructed goes into a single module (the registry fills at
// import time, and ribbit.js imports every type), loaded once per
// AudioContext — OfflineAudioContexts included, which is how a type is
// measured in a test. A processor registered later gets a second module.

const REGISTRY = new Map();
const LOADED = new WeakMap();

// `params` is the list of AudioParam names the processor declares, each
// either a bare name (k-rate) or `{ name, rate: "a-rate" }`. They all
// default to 0: a ribbit param reaches its worklet AudioParam through a
// *connection* from its ConstantSourceNode (see WorkletNode), and connections
// sum onto the intrinsic value, so the intrinsic must be zero.
export function registerWorkletProcessor(name, factory, params = []) {
    REGISTRY.set(name, {
        factory,
        descriptors: params.map((entry) => {
            const { name: paramName, rate = "k-rate" } = typeof entry === "string" ? { name: entry } : entry;
            return { name: paramName, defaultValue: 0, minValue: -3.4e38, maxValue: 3.4e38, automationRate: rate };
        }),
    });
};

function moduleSource(names) {
    const blocks = names.map((name) => {
        const { factory, descriptors } = REGISTRY.get(name);
        return `{
    const Processor = (${factory.toString()})(AudioWorkletProcessor, DSP);
    const descriptors = ${JSON.stringify(descriptors)};
    Object.defineProperty(Processor, "parameterDescriptors", { get: () => descriptors });
    registerProcessor(${JSON.stringify(name)}, Processor);
}`;
    });
    return `const DSP = (${dspLibrary.toString()})();\n${blocks.join("\n")}\n`;
};

// Resolves once every processor registered so far exists in `audioContext`.
export function loadWorklets(audioContext) {
    let state = LOADED.get(audioContext);
    if (!state) {
        state = { names: new Set(), promise: Promise.resolve() };
        LOADED.set(audioContext, state);
    }
    const missing = [...REGISTRY.keys()].filter((name) => !state.names.has(name));
    if (missing.length === 0) return state.promise;

    for (const name of missing) state.names.add(name);
    state.promise = state.promise.then(() => {
        const url = URL.createObjectURL(new Blob([moduleSource(missing)], { type: "application/javascript" }));
        return audioContext.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    }).catch((error) => {
        // Forget them so a later construction can retry, rather than every
        // future type silently waiting on a module that never compiled.
        for (const name of missing) state.names.delete(name);
        throw error;
    });
    return state.promise;
};

// The main-thread end of one worklet processor: owns the AudioWorkletNode
// once it exists, and hides that it doesn't exist yet.
//
// A ribbit type's constructor is synchronous and module loading is not, so
// the node arrives a moment after the object that wraps it. Until then
// `input`/`output` are already-connected GainNodes (the owning channel can
// wire them immediately), messages queue, and nothing sounds — the same
// fire-and-forget arrival samples already have (see known limitations in
// docs/llm/overview.md).
//
// `params` is `{ key: RibbitParam }` — each must come from RibbitParamSources,
// whose `sourceNode` is connected into the worklet's AudioParam of the same
// name. So a ramp, an `at=`, an automation and a `/patch` all reach the
// processor with no per-type code: they move the ConstantSourceNode, and the
// connection carries it.
export class WorkletNode {
    constructor(audioContext, processorName, {
        params = {},
        input = null,
        output,
        outputChannels = 2,
        processorOptions = {},
    } = {}) {
        this.audioContext = audioContext;
        this.processorName = processorName;
        this.input = input;
        this.output = output;
        this.node = null;
        this.onmessage = null;
        this._queue = [];
        this._disposed = false;

        this.ready = loadWorklets(audioContext).then(() => {
            if (this._disposed) return;
            const node = new AudioWorkletNode(audioContext, processorName, {
                numberOfInputs: input ? 1 : 0,
                numberOfOutputs: 1,
                outputChannelCount: [outputChannels],
                channelCount: 2,
                channelCountMode: "explicit",
                channelInterpretation: "speakers",
                processorOptions,
            });
            node.port.onmessage = (event) => this.onmessage?.(event.data);
            for (const [key, param] of Object.entries(params)) {
                const target = node.parameters.get(key);
                if (target && param.sourceNode) param.sourceNode.connect(target);
            }
            if (input) input.connect(node);
            node.connect(output);
            this.node = node;
            for (const [message, transfer] of this._queue) node.port.postMessage(message, transfer);
            this._queue = [];
        }).catch((error) => {
            console.warn(`ribbit: worklet "${processorName}" failed to load`, error);
        });
    };

    post(message, transfer = []) {
        if (this._disposed) return;
        if (this.node) this.node.port.postMessage(message, transfer);
        else this._queue.push([message, transfer]);
    };

    dispose() {
        this._disposed = true;
        if (this.node) {
            this.node.port.postMessage({ type: "dispose" });
            this.input?.disconnect(this.node);
            this.node.disconnect();
            this.node.port.onmessage = null;
        }
        this._queue = [];
    };
};
