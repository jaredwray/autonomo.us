import { SynapseCapture } from "./capture.js";
import { SynapseCommitments } from "./commitments.js";
import { SynapseBriefing } from "./context.js";
import { type MaintenanceOptions, SynapseMaintenance } from "./maintenance.js";
import { SynapseRetriever } from "./retrieval.js";
import type { SynapseService } from "./synapse.js";

/** Everything built on the notes: one of each for a Synapse service. */
export type SynapseFeatures = {
	synapse: SynapseService;
	capture: SynapseCapture;
	retriever: SynapseRetriever;
	commitments: SynapseCommitments;
	briefing: SynapseBriefing;
	maintenance: SynapseMaintenance;
};

export function synapseFeatures(
	synapse: SynapseService,
	options: { maintenance?: MaintenanceOptions } = {},
): SynapseFeatures {
	const retriever = new SynapseRetriever(synapse);
	return {
		synapse,
		capture: new SynapseCapture(synapse),
		retriever,
		commitments: new SynapseCommitments(synapse),
		briefing: new SynapseBriefing(synapse, retriever),
		maintenance: new SynapseMaintenance(synapse, options.maintenance),
	};
}
