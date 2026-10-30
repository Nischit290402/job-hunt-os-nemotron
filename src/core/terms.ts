/**
 * Title term lists, ported from the v0.3.1 Config tab (EXCLUDE_TERMS and EXCLUDE_TERMS_EXTRA merged).
 * Day-to-day scope changes go into the preferences table (kind 'exclude_term' / 'archive_term'), not here.
 */

export interface TermLists {
  exclude: string[];
  senior: string[];
  archive: string[];
  intern: string[];
  role: string[];
  ft: string[];
  program: string[];
  eligTitle: string[];
  eligCompany: string[];
  maxAgeDays: number;
}

const list = (s: string) => s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

export const DEFAULT_TERMS: TermLists = {
  exclude: list(
    'sales,account executive,recruiter,recruiting,legal,counsel,marketing,business development,customer success,support,' +
      'partnerships,product manager,program manager,designer,consultant,consulting,technical writer,accountant,people partner,' +
      'administrative,operation,operations,governance,moderation,annotation,project intern,business analyst,data analyst,analytics,' +
      'postdoctoral,postdoc,professor,lecturer,faculty,full stack,fullstack,frontend,front end,product management,public health,' +
      'facilities,human resources,procurement,payroll,finance,accounting,supply chain,warehouse,clinical,nurse'
  ),
  senior: list('senior,sr,staff,principal,director,head,manager,lead,vp,vice president,executive,architect'),
  archive: list(
    'mlops,ml ops,infrastructure,infra,platform,backend,back-end,devops,sre,reliability,data engineer,data engineering,big data,pipeline'
  ),
  intern: list('intern,internship,attachment,co-op,coop,trainee,student,off-cycle,off cycle,placement'),
  role: list(
    'machine learning,ml,ai,artificial intelligence,deep learning,computer vision,vision,perception,nlp,natural language,llm,' +
      'language model,generative,genai,multimodal,reinforcement learning,rl,research,researcher,applied scientist,data scientist,' +
      'data science,quant,quantitative,algorithm,algorithmic,algo,robotics,agent,agentic,speech,recommendation,recommender,' +
      'diffusion,foundation model,software engineer,software engineering,software developer,swe,forward deployed,fde'
  ),
  ft: list(
    'research engineer,research scientist,machine learning engineer,ml engineer,applied scientist,ai engineer,computer vision,' +
      'quantitative researcher,quant researcher,new grad,graduate,entry level,junior,2028,software engineer,forward deployed engineer'
  ),
  program: list(
    'intern,internship,fellow,fellowship,scholar,scholars,resident,residency,student researcher,co-op,apprentice,part-time,part time,program'
  ),
  eligTitle: list('citizen,citizens,singaporean,singaporeans,permanent resident,pr only,security clearance,clearance'),
  eligCompany: list('dsta,dso,htx,mindef,mha,home team,cyber security agency,csa,govtech'),
  maxAgeDays: 180,
};

/** Adds preference-driven terms (e.g. "exclude_term: agent") on top of the defaults. */
export function withExtraTerms(base: TermLists, extra: { exclude?: string[]; archive?: string[] }): TermLists {
  return {
    ...base,
    exclude: [...base.exclude, ...(extra.exclude ?? []).map((t) => t.toLowerCase())],
    archive: [...base.archive, ...(extra.archive ?? []).map((t) => t.toLowerCase())],
  };
}
