// Public surface of the judgements module: judgement axes and `pass-when`,
// and judging documents and proposals.

export { axisVerdict, parseAxes, type Axis, type AxisVerdict } from './axes.ts';
export { axisModelRequests, type AxisRequest } from './requests.ts';
export { judgeDocument, judgeProposal, type AxisJudgement, type Judgement, type JudgementDeps, type JudgementError, type UnjudgedAxis } from './judge.ts';
