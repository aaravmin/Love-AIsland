import type {
  AgentContextView,
  Class,
  ConvOutcome,
  NearbyAgent,
  OverheardFragment,
  RelationshipSummary,
  Tone,
} from "@arena/shared";
import { tunables } from "@arena/shared";
import type { LLMResult, ModelBackend, TranscriptLine } from "../backend.js";
import { ZERO_USAGE } from "../backend.js";
import {
  chooseTopic,
  conflictChance,
  deflectionPlan,
  fallbackDecision,
  rankVoteTargets,
  type Topic,
} from "../fallback.js";

// ---------------------------------------------------------------------------
// The rule backend: a complete brain that needs no model of any kind.
//
// Decisions come from the deterministic engine in fallback.ts. Speech comes
// from templates chosen by the relationship between the two islanders and the
// state of the world around them: are they allied, is one of them hurt, has the
// partner been racking up kills, has a death just landed, do these two have
// history, did somebody overhear something, is a Purge or a vote bearing down,
// has it turned hostile. The template is then filled with the real names, so a
// model-off game still sounds like two specific people talking about their
// actual situation rather than a generic bot exchange.
//
// This is both the shipped fallback (whenever no model is reachable or a call
// fails) and the decision source for the headless balance harness, so it stays
// deterministic under a seeded `rand`.
//
// IT IS ALSO, IN PRACTICE, THE WHOLE DIALOGUE ENGINE. Any run with
// SWARM_BACKEND=rules, any run where the configured model is unreachable, and
// every harness run serve 100% of their lines from this file. It is written as
// a first-class dialogue engine on that basis rather than as a stub, which is
// what the four sections below are about:
//
//   1. VOICE. Pool selection reads stats and persona, not only class, so a
//      resolve-8 charmer and a resolve-1 charmer do not speak the same
//      sentences. Class picks the subject matter; the voice picks the register
//      inside it and reshapes the sentence.
//   2. MEMORY. A per-agent ring of recently spoken line ids spans conversations,
//      so a line an islander used ten minutes ago is not its next opener.
//   3. REACTION. A turn reads the partner's previous line before choosing, so an
//      exchange is a conversation rather than two interleaved monologues. A
//      hostile line is never answered with a sunbed joke.
//   4. AWARENESS. Relationship history, overheard fragments, recent world events
//      and the crowded/secluded read all select pools, so the same pair in the
//      same physical state does not produce the identical line every time they
//      meet.
//
// All four sit behind tunables.flags.conversationVariety, which is the flag that
// governs dialogue quality and which the master switch turns on. With it off,
// speakLegacy and chooseOutcomeLegacy below run the pre-spec code verbatim,
// including drawing exactly the same number of values from `rand` in the same
// order, so ISLAND_BEHAVIOR_ALL=0 reproduces the old build's transcripts.
// ---------------------------------------------------------------------------

// A speaking register. Two islanders of the same class draw from different
// slices of the same pool depending on how they are built: the loud confident
// one is `forward`, the easily swayed one is `reserved`, the high-cunning one
// gets the `sly` lines the plain-dealing one never reaches for. An untagged line
// is available to everybody, which is how a pool can hold both the lines that
// characterize a voice and the ones that just belong to the class.
type Register = "forward" | "reserved" | "warm" | "dry" | "sly" | "open";

type Line = [string, Tone, Register?];

// The relationship/world reading that selects which template pool to speak
// from. Ordered by urgency: what is happening right now outranks small talk.
//
// The last four are the behavior spec's awareness intents. They exist because
// the pre-spec readIntent was a pure function of (event kind, allied, partner
// HP, notoriety, own HP), so two islanders standing in the same physical state
// produced the identical intent, hence the identical pool, every single time
// they met, no matter what had passed between them.
type Intent =
  | "hostile"
  | "allyHurt"
  | "ally"
  | "wary"
  | "campaign"
  | "vulnerable"
  | "small"
  // Added by the behavior spec.
  | "aftermath" // something just happened to the villa
  | "grudge" // this pair has history and it is bad
  | "warmth" // this pair has history and it is good
  | "gossip"; // this agent overheard something worth passing on

// The behavior spec's three additions to that list. They sit between the urgent
// intents and small talk: a vote closing in on you outranks gossip, and picking
// a fight outranks the weather, but neither outranks an endgame or a hurt ally.
type PlayIntent = "deflect" | "voteCase" | "needle";

// How a turn answers the line that came before it. Selected from the partner's
// tone rather than from this agent's own situation, which is the whole point:
// without it a hostile accusation gets answered with a joke about the seagulls.
type ReactIntent = "rebuff" | "placate" | "doubt";

const LOW_HP = 0.4;
const NOTORIOUS = 20;

// A stat at or above this reads as "high" for voice purposes, at or below the
// low mark as "low". Stats run 1..8 on a 35 point budget, so 5 is a little above
// an even spread and 4 a little below: the split lands close to half the cast on
// each side of every axis, which is what makes the voices actually differ.
const STAT_HIGH = 5;
const STAT_LOW = 4;

// A relationship this negative on any axis is a grudge, this positive is warmth.
const GRUDGE_THREAT = 0.45;
const GRUDGE_TRUST = -0.25;
const WARM_TRUST = 0.3;

// How likely each intent is to produce ANY outcome at all rather than "nothing".
// This is the mechanism behind the spec's "Most conversations end here" (None).
// Ordinary talk commits rarely; an endgame conversation almost always does.
const COMMIT_CHANCE: Record<Intent, number> = {
  hostile: 0.95,
  allyHurt: 0.45,
  aftermath: 0.3,
  grudge: 0.55,
  ally: 0.4,
  wary: 0.45,
  campaign: 0.45,
  vulnerable: 0.35,
  gossip: 0.22,
  warmth: 0.45,
  small: 0.28,
};

// --- state-driven pools ----------------------------------------------------
// {p} is the partner's name, {s} the speaker's. Written to read naturally in
// either the middle or the last line of an exchange.

// The six ORIGINAL pools, unchanged in content, order and length so the
// flags-off path draws exactly the line it always did. Register tags are a third
// tuple slot and do not move an index.
type LegacyIntent = "hostile" | "allyHurt" | "ally" | "wary" | "campaign" | "vulnerable";

const INTENT_LINES: Record<LegacyIntent, Line[]> = {
  hostile: [
    ["No more villa, no more games. It's you or me now, {p}.", "hostile", "forward"],
    ["I liked you, {p}. That's going to make this so much worse.", "hostile", "warm"],
    ["Don't look at me like that. There's nowhere left for either of us to go.", "hostile", "dry"],
    ["Whatever we were before today, {p}, it doesn't count anymore.", "hostile", "reserved"],
    ["I'm not apologizing for wanting to be the one who walks out.", "hostile", "forward"],
  ],
  allyHurt: [
    ["{p}, you look rough. Sit down before you fall down, I've got you.", "friendly", "warm"],
    ["Hey. Stay behind me today. I'm not losing you over something stupid.", "friendly", "forward"],
    ["You're not okay and you're doing the thing where you say you're fine.", "friendly", "dry"],
    ["Take my shade and my water, {p}. Argue with me later when you can stand.", "friendly", "warm"],
    ["I've seen you patched up better than this. Who did it? I'll have words.", "friendly", "forward"],
  ],
  ally: [
    ["Us against this whole ridiculous island, {p}. Still holding.", "friendly", "forward"],
    ["I don't say it enough, but I'm glad it was you I ended up with here.", "friendly", "warm"],
    ["Whatever they're whispering about us, let them. I'm not going anywhere.", "friendly", "dry"],
    ["Same time tomorrow, {p}? Bad coffee, worse gossip, usual bench.", "friendly", "open"],
    ["You're the only person here I don't have to perform for. That's rare.", "friendly", "reserved"],
  ],
  wary: [
    ["People talk about you, {p}. I'd rather hear your version than theirs.", "neutral", "open"],
    ["I'm not scared of you. I'm just not stupid either.", "neutral", "forward"],
    ["You've got a body count and a nice smile. That's a strange combination.", "neutral", "dry"],
    ["Tell me straight, {p}. Am I on your list or not?", "neutral", "forward"],
    ["I'll be civil. Don't mistake that for me turning my back on you.", "neutral", "reserved"],
  ],
  campaign: [
    ["If it comes down to a vote, {p}, I hope you remember I was decent to you.", "friendly", "warm"],
    ["Everyone's counting heads today. I'd rather just sit here with you.", "friendly", "reserved"],
    ["I'm not going to beg. I'd just like to still be here on Friday.", "neutral", "dry"],
    ["Bad week to have enemies, so let's not be that, {p}.", "friendly", "open"],
    ["Whatever happens when they call names, no hard feelings from me.", "friendly", "warm"],
  ],
  vulnerable: [
    ["I'm running on nothing, {p}. Don't tell the others I said that.", "neutral", "reserved"],
    ["Honestly? I'm tired. Some days this place just wins.", "neutral", "dry"],
    ["I keep smiling for the cameras and then I sit down and I'm just empty.", "neutral", "open"],
    ["Can I be pathetic for one minute? Then I'll go back to being fine.", "friendly", "warm"],
    ["I don't have much left in the tank. Be gentle with me today.", "friendly", "reserved"],
  ],
};

// Everything the behavior spec adds on top, appended to the pools above only
// when conversationVariety is on. Five lines per situation across a fifty
// islander cast was the arithmetic behind "they say the same things
// consistently"; the six legacy pools roughly triple here, and the four
// awareness pools below them did not exist at all.
const INTENT_LINES_EXTRA: Record<Exclude<Intent, "small">, Line[]> = {
  hostile: [
    ["I have thought about how this ends for weeks. It was always going to be here.", "hostile", "sly"],
    ["Say something kind if you want. It will not change what happens next.", "hostile", "dry"],
    ["I did not choose this part of it, {p}. I am still going to finish it.", "hostile", "open"],
    ["One of us walks off this beach. I have decided which and so have you.", "hostile", "forward"],
    ["Do not make me explain myself. There is no version of this where I lose.", "hostile", "sly"],
    ["We were never going to be the two who made it out together, were we.", "hostile", "reserved"],
    ["I am sorry it is you. I am not sorry enough to stop.", "hostile", "warm"],
    ["I stopped feeling bad about this some time yesterday, {p}.", "hostile", "reserved"],
    ["Do not run. I would rather not have to chase you across a beach.", "hostile", "sly"],
    ["This was always the ending. We just both had to get here.", "hostile", "dry"],
    ["Say your piece. I will listen. Then I am going to do it anyway.", "hostile", "open"],
    ["You have been dangerous to me since the first week. I am correcting that.", "hostile", "forward"],
    ["I will make it quick. That is the only kindness left in here.", "hostile", "warm"],
    ["There is no clever way out of this one. I have looked for days.", "hostile"],
  ],
  allyHurt: [
    ["Do not move. I will bring everything to you and you will let me.", "friendly", "open"],
    ["You have carried me twice this week. Sit down and let me return it.", "friendly", "warm"],
    ["I am not asking how you are. I can see. Just breathe for a minute.", "friendly", "reserved"],
    ["Whoever did this is going to have a very long week, {p}. I promise you.", "hostile", "forward"],
    ["Eat. Then sleep. The villa can survive one afternoon without you in it.", "friendly", "dry"],
    ["Stay where people can see you today. Nobody tries anything in front of an audience.", "neutral", "sly"],
    ["I will keep talking so nobody comes over. You do not have to say a word.", "friendly", "open"],
    ["I am not leaving. Ask me again and I am still not leaving.", "friendly", "forward"],
    ["Lean on me. You would do it for me and you would not ask either.", "friendly", "warm"],
    ["You look terrible. I say that with enormous affection.", "friendly", "dry"],
    ["Tell me who to watch tonight and then stop talking and rest.", "neutral", "sly"],
    ["I will sit here. You do not have to be interesting, {p}.", "friendly", "reserved"],
    ["What do you need? Say the actual thing, not the brave version.", "friendly", "open"],
    ["Nothing is happening to you today. I have decided that on your behalf.", "friendly"],
  ],
  ally: [
    ["If somebody moves on you, {p}, they are moving on me. I want that said out loud.", "friendly", "forward"],
    ["We should talk less where people can see us. It is starting to look organized.", "neutral", "sly"],
    ["Nothing has changed on my side, {p}. I would rather you heard that than assumed it.", "friendly", "open"],
    ["I keep waiting for the part where you turn on me. It has not come.", "neutral", "reserved"],
    ["Two of us thinking beats the whole villa guessing. Keep telling me things, {p}.", "friendly", "sly"],
    ["You get the last of the good coffee. That is the highest honour I have.", "friendly", "warm"],
    ["We are going to be sat next to each other at the end of this. I can feel it.", "friendly", "forward"],
    ["Do not do anything clever without telling me first. That is all I ask.", "neutral", "dry"],
    ["I want one person in here I never have to second guess. You are it, {p}.", "friendly", "forward"],
    ["If it goes wrong for me, I want you to keep going. Do not be sentimental about it.", "friendly", "forward"],
    ["I do not need reassuring. I would still quite like some.", "friendly", "reserved"],
    ["I am not good at saying this part out loud, so take it as said.", "friendly", "reserved"],
    ["You have been the one steady thing in a week of nonsense, {p}.", "friendly", "warm"],
    ["I would go a long way out of my way for you. I hope that is obvious by now.", "friendly", "warm"],
    ["We are the least dramatic pair in this villa and I am extremely proud of that.", "friendly", "dry"],
    ["If you start being nice to me I will assume something terrible has happened.", "friendly", "dry"],
    ["Keep an eye on who is suddenly being lovely to you. That is never free.", "neutral", "sly"],
    ["Let us not be seen agreeing too loudly today. Nod at me and walk off.", "neutral", "sly"],
    ["Tell me if I am playing this badly. You are the only one who would.", "neutral", "open"],
    ["What are you actually worried about? Not the game answer. The real one.", "friendly", "open"],
    // Untagged, so every voice can reach them. A pool needs some shared
    // vocabulary or the register slices starve independently of each other.
    ["Whatever they decide tonight, we walk in knowing where we both stand.", "friendly"],
    ["I have your back. That is not a strategy sentence, it is just true.", "friendly"],
    ["Nobody has come to me about you. I would tell you the second they did.", "neutral"],
    ["Same bench tomorrow. I am not renegotiating that with anybody.", "friendly"],
  ],
  wary: [
    ["I keep my distance from you and I would like you to know it is not personal.", "neutral", "reserved"],
    ["Everybody is being very careful around you this week. I have noticed why.", "neutral", "sly"],
    ["I would rather be friendly with you than the alternative. That is all this is.", "neutral", "warm"],
    ["You do not have to like me. You do have to not come near me at night.", "neutral", "dry"],
    ["I have watched what you do to people who trust you. Consider me informed.", "neutral", "sly"],
    ["People keep telling me stories about you. I would rather have the real one.", "neutral", "open"],
    ["I am not going to pretend I have not thought about what you are capable of.", "neutral", "forward"],
    ["I would like us to be fine. I am just not going to assume it.", "neutral", "open"],
    ["You are the most interesting problem in this villa, {p}. I mean that carefully.", "neutral", "sly"],
    ["I will sit here. I am going to keep the exit behind me though.", "neutral", "dry"],
    ["Say one true thing and I will start revising my opinion of you.", "neutral", "forward"],
    ["I do not want anything from you. That should make this easier.", "neutral", "reserved"],
    ["People flinch when you walk in. I doubt you have noticed. I have.", "neutral", "warm"],
    ["I am polite to you for the same reason everybody else is. Let us both know that.", "neutral"],
  ],
  campaign: [
    ["I am not going to insult you, {p}, by pretending this is a normal afternoon.", "neutral", "forward"],
    ["Say my name is not being said and I will believe you. That is where I am at.", "neutral", "reserved"],
    ["I have been good to people here. I would like that to be worth something today.", "friendly", "open"],
    ["Do not tell me who you are voting. Just tell me it is not me.", "neutral", "sly"],
    ["If you need somebody to stand next to when they call it, I am right here.", "friendly", "warm"],
    ["Everybody has gone very quiet and very polite. That is always the tell.", "neutral", "dry"],
    ["I would rather lose honestly than spend today grovelling at people.", "neutral", "forward"],
    ["I am asking, not bargaining. There is a difference and I want it noted.", "neutral", "forward"],
    ["If I go tonight, I would like one person here to have been straight with me.", "neutral", "reserved"],
    ["I have counted. I do not like the answer. I am telling you anyway.", "neutral", "dry"],
    ["Nobody has looked me in the eye since lunch. That is its own answer.", "neutral", "sly"],
    ["Whatever you decide, come and tell me first. That is all I want.", "friendly", "warm"],
    ["Do you think I deserve to go? Answer that and I will leave you alone.", "neutral", "open"],
    ["I am not going to spend my last afternoon here begging. I would rather talk to you.", "neutral"],
  ],
  vulnerable: [
    ["I have been pretending to be fine so long I have lost track of whether I am.", "neutral", "open"],
    ["Do not make a fuss. Just sit here a while and talk about nothing.", "neutral", "dry"],
    ["I am one bad afternoon from asking to go home, and I would hate myself for it.", "neutral", "reserved"],
    ["You are the only person I would say any of this in front of, {p}.", "friendly", "warm"],
    ["I will be upright again by tonight. I just need this hour.", "neutral", "forward"],
    ["Everything hurts and I have decided to find that funny rather than sad.", "neutral", "dry"],
    ["Do not tell anyone I sat down. Half of them are counting who looks weak.", "neutral", "sly"],
    ["I am going to be fine. I would just rather not be alone while I get there.", "neutral", "forward"],
    ["Do not look at me like that or I will actually start crying.", "neutral", "warm"],
    ["I have run out of the energy it takes to be a person today.", "neutral", "dry"],
    ["Sit down and talk at me about something that does not matter. Please.", "neutral", "open"],
    ["I am not asking for anything. I just did not want to sit on my own.", "neutral", "reserved"],
    ["If anybody asks, I was fine and we talked about the weather.", "neutral", "sly"],
    ["I will be alright. I always am. It just takes me a bit longer lately.", "neutral"],
  ],

  // --- the awareness pools -------------------------------------------------
  // These four are the spec's Task D made audible. Each is selected from a
  // signal the pre-spec engine computed and then dropped on the floor: recent
  // world events, relationship history, and overheard fragments.

  // Something just happened to the villa. {n} is the living count, which is the
  // one villa-wide number an islander can honestly know, because it can count
  // the people in front of it.
  aftermath: [
    ["That just happened and I do not think any of us have caught up with it yet.", "neutral", "open"],
    ["{n} of us. That is it. Count the beds tonight and it will not feel real.", "neutral", "dry"],
    ["I keep looking at the empty seat. Sorry. I will stop.", "neutral", "reserved"],
    ["We are down to {n} and everybody is being very quiet about what that means.", "neutral", "sly"],
    ["Whatever we were all playing at last week, that is over now, {p}.", "neutral", "forward"],
    ["Somebody said something horrible about it at breakfast and everybody laughed.", "neutral", "dry"],
    ["I did not think it would land like this. I did not know them that well.", "neutral", "reserved"],
    ["Right. {n} left. So the maths on everything just changed for all of us.", "neutral", "sly"],
    ["Are you alright? Genuinely. Nobody has asked anybody that all morning.", "friendly", "warm"],
    ["I would like one day where nothing happens. One. Then I will go back to playing.", "neutral", "open"],
    ["Everyone is being extremely nice to each other today and it is terrifying.", "neutral", "dry"],
    ["Say what you like about this place, {p}, it does not let you get comfortable.", "neutral", "forward"],
    ["I have not slept properly since it happened. I doubt you have either.", "friendly", "warm"],
    ["Nobody has moved their things yet. Everyone is waiting for somebody else to.", "neutral", "reserved"],
    ["Right. We deal with it and we keep moving. That is all there is.", "neutral", "forward"],
    ["Somebody needs to say it out loud, so I will. That was grim.", "neutral", "forward"],
    ["I do not really want to talk about it. I did not want to sit alone either.", "neutral", "reserved"],
    ["I keep starting sentences about it and then not finishing them.", "neutral", "reserved"],
    ["Come here. No talking, no strategy, just sit down for a minute.", "friendly", "warm"],
    ["If it gets to you later, come and find me. I mean that, {p}.", "friendly", "warm"],
    ["Breakfast was the quietest meal I have ever sat through in my life.", "neutral", "dry"],
    ["Everybody is pretending to be busy. Nobody is doing anything at all.", "neutral", "dry"],
    ["Watch who moves first now. That tells you more than the last two weeks did.", "neutral", "sly"],
    ["Somebody in here is already counting what this changes for them. I would bet on it.", "neutral", "sly"],
    ["Does it feel different to you today, or is that just me being morbid?", "neutral", "open"],
    ["I did not expect it to shake me and it has. Is that stupid?", "neutral", "open"],
    ["{n} of us, and suddenly everybody knows everybody's name properly.", "neutral"],
    ["Nobody won anything today. That is the bit people keep forgetting.", "neutral"],
    ["I have thought about going home about six times since it happened.", "neutral"],
    ["We are all going to be very strange for about a day. That is allowed.", "neutral"],
  ],

  // This pair has history and it is bad. Written to carry the grudge without
  // reciting a ledger, because an islander remembers the feeling, not the count.
  grudge: [
    ["We are going to have to talk about it eventually, {p}. It might as well be now.", "neutral", "forward"],
    ["I have not forgotten. I am just being polite about it in front of people.", "neutral", "sly"],
    ["Every time you walk past me, {p}, I feel it again. That is not going on its own.", "hostile", "open"],
    ["You and I are never going back to how it was. I would rather we both said so.", "neutral", "dry"],
    ["I do not trust you, {p}. You have not given me one reason to since it happened.", "hostile", "forward"],
    ["Do not do the warm voice with me. I know exactly what you are.", "hostile", "dry"],
    ["I am willing to be civil. I am not willing to pretend it did not happen.", "neutral", "reserved"],
    ["Funny how you only find me friendly when you need the numbers, {p}.", "hostile", "sly"],
    ["I keep my mouth shut about you. Do not mistake that for having let it go.", "neutral", "reserved"],
    ["If you want this fixed, you have to actually say the thing. You never do.", "neutral", "open"],
    ["Half this villa thinks we are fine. Only you and I know we are not.", "neutral", "sly"],
    ["I have been decent to you since. That took work. You should know that.", "neutral", "warm"],
    ["You cost me something, {p}, and you have never once acknowledged it.", "hostile", "forward"],
    ["I am not angry any more. That is worse for you, if you think about it.", "neutral", "dry"],
    ["I am going to say this once and then I am going to drop it, {p}.", "neutral", "forward"],
    ["You know exactly what you did. I am not going to perform it for you.", "hostile", "forward"],
    ["I would rather sit somewhere else, if that is alright.", "neutral", "reserved"],
    ["I am fine. I am just not going to be warm with you and I will not pretend.", "neutral", "reserved"],
    ["I wanted to like you. That is the part that still annoys me.", "neutral", "warm"],
    ["I am not going to be cruel about it. I am also not going to forget.", "neutral", "warm"],
    ["Lovely weather. Great chat. We both know why this is uncomfortable.", "neutral", "dry"],
    ["You have apologised to everyone in this villa except me. I have counted.", "hostile", "dry"],
    ["I have been very careful about what I say near you. Take that how you like.", "neutral", "sly"],
    ["People ask me about you and I say something kind. You should be grateful.", "neutral", "sly"],
    ["Do you actually think we are fine? I would genuinely like to know.", "neutral", "open"],
    ["Tell me what you thought was going to happen. I am asking honestly.", "neutral", "open"],
    ["Neither of us is going to say the thing, so we may as well sit here.", "neutral"],
    ["I am not going to make a scene about it. I am also not going to smile.", "neutral"],
  ],

  // This pair has history and it is good.
  warmth: [
    ["You have been sound with me from the first day and I do not forget things like that.", "friendly", "warm"],
    ["Whatever else this place does to us, I am glad we ended up on the same side of it.", "friendly", "open"],
    ["I told somebody yesterday you were the one person here I actually believe.", "friendly", "warm"],
    ["We do not have to do the strategy voice. Just sit here and be normal with me.", "friendly", "reserved"],
    ["You are steady, {p}. There is not a lot of steady left in this villa.", "friendly", "dry"],
    ["I have watched you be kind when nobody was looking. That is the whole test.", "friendly", "open"],
    ["If it ever comes down to you and me at the end, I am fine with that.", "friendly", "forward"],
    ["I would tell you if something was moving. You know I would.", "friendly", "sly"],
    ["Do not go weird on me now that it is getting serious. I like you as you are.", "friendly", "warm"],
    ["You make this bearable. I am not being dramatic, I mean it plainly.", "friendly", "reserved"],
    ["I have stopped double checking what you tell me. That took about a week.", "friendly", "sly"],
    ["Whatever happens to me here, I would like you to still be standing after.", "friendly", "forward"],
    ["I would not have lasted this long in here without you and I know it.", "friendly", "forward"],
    ["You are getting a proper thank you when we are both out of this place.", "friendly", "forward"],
    ["I do not say much. I hope you know what it means when I sit with you.", "friendly", "reserved"],
    ["I find you very easy to be around. That is rarer than it sounds.", "friendly", "reserved"],
    ["You checked on me when nobody else did. I have not forgotten it, {p}.", "friendly", "warm"],
    ["I would like us to still know each other in a year. Genuinely.", "friendly", "warm"],
    ["You are the only person here who has never once made me tired.", "friendly", "dry"],
    ["I have said nothing bad about you all week. Do you know how hard that is here?", "friendly", "dry"],
    ["If anybody comes asking about you, they get nothing from me. Ever.", "friendly", "sly"],
    ["I would tip you off before I did anything. That is not nothing in here.", "neutral", "sly"],
    ["Tell me how you are actually doing. I will know if you dress it up.", "friendly", "open"],
    ["What do you need from me this week? Just say it plainly.", "friendly", "open"],
    ["I am glad it was you on that first day. I have thought that a lot since.", "friendly"],
    ["You have never once made me feel stupid in here. Nobody else can say that.", "friendly"],
  ],

  // Passing on something overheard. {g} is who was talking, {q} a short bit of
  // what they said, {t} whoever it was about.
  gossip: [
    ["I heard {g} saying it, {p}. Something like, {q}. Make of that what you like.", "neutral", "sly"],
    ["Do not repeat this. {g} was talking about {t} and it was not friendly.", "deceptive", "sly"],
    ["I caught the end of something by the pool. {q}. That was {g}, out loud.", "neutral", "open"],
    ["I was not listening on purpose. But {g} said {q} and I have thought about it since.", "neutral", "reserved"],
    ["You should know what is being said about {t}. It came from {g} and it stuck.", "neutral", "forward"],
    ["Half the villa heard {g} yesterday. {q}. Nobody has mentioned it since.", "neutral", "dry"],
    ["I will tell you what {g} said, {p}, if you promise not to look like you know.", "deceptive", "sly"],
    ["{g} talks a lot when they think nobody is near. That is all I am saying.", "neutral", "dry"],
    ["Something is going on with {t} and I only know because {g} is careless.", "neutral", "sly"],
    ["I do not like carrying this, {p}, but you would want to know. {q}.", "neutral", "warm"],
    ["{g} said {q} and then looked round to see who was listening. I was.", "neutral", "reserved"],
    ["I have been sitting on this all morning. {g}, about {t}. Draw your own conclusion.", "deceptive", "forward"],
    ["Nobody was supposed to hear that. I heard it, {p}. So now you have.", "neutral", "sly"],
    ["{g} has been saying things about {t} that I would want to know about.", "neutral", "forward"],
    ["I will say it once and then deny it. {q}. That was {g}.", "deceptive", "dry"],
    ["I have been decent about not repeating this. My patience just ran out.", "neutral", "warm"],
    ["You did not hear it from me. {g} was very clear about {t}.", "deceptive", "reserved"],
    ["Ask {g} what they said by the pool. Watch their face when you do.", "neutral", "open"],
    ["I am telling you because somebody should have told me. {q}.", "neutral"],
  ],
};

// The pool an intent speaks from when the dialogue engine is on: the original
// lines plus everything the spec added.
function intentPool(intent: Exclude<Intent, "small">): Line[] {
  const base = (INTENT_LINES as Partial<Record<Exclude<Intent, "small">, Line[]>>)[intent] ?? [];
  return [...base, ...INTENT_LINES_EXTRA[intent]];
}

// --- reaction pools --------------------------------------------------------
// Answers to the previous line rather than statements about this agent's own
// situation. Without these an exchange is two monologues that happen to share a
// bench.

const REACT_LINES: Record<ReactIntent, Line[]> = {
  // Somebody just came at this agent and it is built to come back.
  rebuff: [
    ["Say that again slowly, {p}, and think about who you are saying it to.", "hostile", "forward"],
    ["No. You do not get to talk to me like that and then walk off.", "hostile", "forward"],
    ["That is a very brave thing to say out loud on a beach this small.", "hostile", "sly"],
    ["Right. So we are doing this. Fine. I have been waiting for you to start.", "hostile", "dry"],
    ["You have just told me exactly where I stand with you. Thank you for that.", "hostile", "reserved"],
    ["I would be careful, {p}. I am not the one you want to be short with.", "hostile", "sly"],
    ["Funny. Everyone else in here manages to be civil to me.", "hostile", "dry"],
    ["If you have a problem with me, have it properly. Do not do it sideways.", "hostile", "forward"],
    ["I heard you. I am choosing not to answer it the way I want to.", "neutral", "reserved"],
    ["You are angry at somebody and it is not me. Aim it somewhere useful.", "neutral", "open"],
    ["Do not raise your voice at me. I am standing right here.", "hostile", "forward"],
    ["That is exactly the sort of thing you say and then regret by dinner.", "hostile", "dry"],
    ["I have been waiting for you to show me this side. There it is.", "hostile", "sly"],
    ["No. I am not doing the version of this where I apologise for existing.", "hostile", "reserved"],
    ["You want a reaction. I am going to give you a very calm one.", "neutral", "warm"],
    ["Go on then, finish it. I would hate for you to stop halfway.", "hostile", "open"],
    ["I am not going to shout back. I am going to remember this instead.", "hostile"],
  ],
  // Somebody just came at this agent and it is built to take the heat out.
  placate: [
    ["Okay. Okay. Nobody needs to shout. Just tell me what actually happened.", "friendly", "warm"],
    ["I am not going to fight you about this, {p}. I would rather just fix it.", "friendly", "open"],
    ["That is fair. I am not going to pretend it is not. Give me a minute.", "neutral", "reserved"],
    ["Please do not. I cannot do a row today, I really cannot.", "friendly", "reserved"],
    ["You are upset and I do not think it is about me, but I will listen anyway.", "friendly", "warm"],
    ["Can we sit down before this gets said in front of everybody?", "neutral", "open"],
    ["Alright. Say the whole thing. I will not interrupt you once.", "neutral", "dry"],
    ["I would rather lose the argument than lose you being able to look at me.", "friendly", "warm"],
    ["Whatever you heard, it came out wrong somewhere. Ask me and I will tell you.", "neutral", "open"],
    ["I am sorry. I mean that plainly, without any of the clever bit after it.", "friendly", "warm"],
    ["Right. Take a breath. I am not going anywhere and neither is this.", "friendly", "forward"],
    ["I think we are both saying the same thing badly. Let me try again.", "neutral", "open"],
    ["That is a lot. I am not going to pretend I have an answer right now.", "neutral", "dry"],
    ["I do not want this to be a thing between us, {p}. Tell me how to fix it.", "friendly", "warm"],
    ["I will just listen. You do not have to be fair to me while you do it.", "friendly", "reserved"],
    ["Okay. I hear you. I am not arguing with any of that.", "neutral", "sly"],
    ["You are allowed to be angry with me. I would just rather we got through it.", "friendly"],
  ],
  // The last line was smooth and this agent does not buy it.
  doubt: [
    ["That was a lovely answer, {p}. It was not the one I asked for.", "neutral", "sly"],
    ["Mm. You said all of that without saying anything. That is a skill.", "neutral", "dry"],
    ["I want to believe you. Give me something I can actually check.", "neutral", "open"],
    ["You are very good at this. I mean that as a warning to myself.", "neutral", "sly"],
    ["Everybody in here talks like that right before they do something.", "neutral", "dry"],
    ["I will take it at face value for now. I am telling you that on purpose.", "neutral", "reserved"],
    ["Say it again without the smile and I might buy it.", "neutral", "forward"],
    ["That is the second time you have answered a different question, {p}.", "neutral", "sly"],
    ["I like you. I just do not think you are telling me the whole thing.", "neutral", "warm"],
    ["Fine. But if that turns out to be a story I will remember you told it here.", "neutral", "forward"],
    ["You have an answer for everything today. That is usually a sign.", "neutral", "dry"],
    ["I would love that to be true. Convince me properly and I will drop it.", "neutral", "open"],
    ["That is the most careful sentence anybody has said to me all week.", "neutral", "sly"],
    ["Right. And if I asked somebody else, would I get the same story?", "neutral", "forward"],
    ["I am not calling you a liar. I am noting that I noticed.", "neutral", "reserved"],
    ["You are being very generous with the details that help you, {p}.", "neutral", "warm"],
    ["I will let that go for now. I want you to know it is being let go.", "neutral"],
  ],
};

// --- truce vocabulary ------------------------------------------------------
// The word "truce" used to sit inside three of the five class reply pools, so
// the speech itself pushed the villa toward the outcome that already dominated.
// It now lives in exactly one pool, reached only on the turn a truce is actually
// the outcome being chosen, which is the speech-side half of the same fix.

const TRUCE_LINES: Line[] = [
  ["Alright. Line under it. We both walk away from this one, {p}.", "friendly", "forward"],
  ["A truce then. Less shouting, more surviving, which is my whole plan anyway.", "friendly", "warm"],
  ["I am not apologizing and neither are you. But we are done with it. Agreed?", "neutral", "dry"],
  ["Whatever the word is. I would rather have you not looking at me like that.", "neutral", "open"],
  ["Peace, for now. I reserve the right to be annoyed about it privately.", "friendly", "sly"],
  ["We leave it there. If it comes back up it will not be me who raised it.", "neutral", "reserved"],
  ["Deal. And nobody else in this villa needs to know we had that conversation.", "neutral", "sly"],
  ["I would like to stop being careful around you. Can we do that?", "friendly", "warm"],
];

// --- the play pools --------------------------------------------------------
// {t} is a third party: the name being steered toward, or the name being made a
// case against. Every line here is written to work without knowing anything
// about the target beyond the name, because the rule engine often does not.

// The six ORIGINAL lines per play, unchanged in content, order and length so
// the flags-off path is untouched. Extensions live in PLAY_LINES_EXTRA below.
const PLAY_LINES: Record<PlayIntent, Line[]> = {
  deflect: [
    ["If names are getting written down tonight, {p}, I would rather it was not mine.", "neutral", "open"],
    ["I know exactly how this looks for me. I also know {t} has been busier than I have.", "neutral", "sly"],
    ["You have been straight with me, so I will be straight with you. I am worried.", "friendly", "warm"],
    ["Ask yourself who actually gains if I go home. It is not you, {p}.", "neutral", "forward"],
    ["I am not going to campaign at you. Just look at what {t} has been doing all week.", "neutral", "sly"],
    ["Whatever you have heard about me this week, I would rather you heard it from me.", "friendly", "open"],
  ],
  voteCase: [
    ["{t} beats every one of us at the end. That is the whole problem, {p}.", "neutral", "forward"],
    ["Everybody adores {t}. That is exactly why it has to be their name.", "neutral", "sly"],
    ["I am not doing this out of spite. I can count, and the count says {t}.", "neutral", "dry"],
    ["If the votes are not there for {t}, I would rather wait than waste mine.", "neutral", "reserved"],
    ["Liking somebody and keeping them are two different decisions, {p}.", "neutral", "open"],
    ["Tell me honestly who you would want sitting next to you at the end. Then tell me why.", "neutral", "open"],
  ],
  needle: [
    ["I am going to say the thing nobody else will. {p}, you have been playing us.", "hostile", "forward"],
    ["You smile at me and then talk about me the second I walk off. I have heard.", "hostile", "sly"],
    ["Somebody in this villa lies to my face daily. I am narrowing the list down.", "neutral", "dry"],
    ["Do not take this the wrong way, {p}, but I do not buy a word of it.", "hostile", "forward"],
    ["I would rather have this out with you now than be polite about it all week.", "neutral", "open"],
    ["You have got very comfortable here. I think it is time somebody changed that.", "hostile", "forward"],
  ],
};

const PLAY_LINES_EXTRA: Record<PlayIntent, Line[]> = {
  deflect: [
    ["I have been useful to you. I am asking you to remember that for one night.", "neutral", "reserved"],
    ["Everybody has decided it is me because it is easy. {t} is the actual answer.", "neutral", "forward"],
    ["I am not going to insult you with a speech. I just do not want to go yet.", "neutral", "dry"],
    ["Tell me honestly if it is already decided. I would rather know than hope.", "neutral", "reserved"],
    ["One name changes and I am still here tomorrow. That is all I am asking about.", "neutral", "sly"],
    ["If you were sat where I am, I would be doing this for you. You know that.", "friendly", "warm"],
    ["I can feel the room deciding without me in it. That is a horrible feeling.", "neutral", "open"],
  ],
  voteCase: [
    ["Nobody has said {t} out loud yet. Somebody has to be first and it may as well be me.", "neutral", "forward"],
    ["I have run it every way I can. Every version where I win, {t} is already gone.", "neutral", "sly"],
    ["This is not about who I like. I like {t}. That is what makes it urgent.", "neutral", "warm"],
    ["We do not have the numbers today. So we do not move today. Simple as that.", "neutral", "reserved"],
    ["If we do this it has to be everybody at once. A half done vote gets us both.", "neutral", "sly"],
    ["Do not answer now. Just count the room tonight and see if you get what I got.", "neutral", "dry"],
    ["I would rather be wrong about {t} than be sat here next week wishing I had said it.", "neutral", "open"],
  ],
  needle: [
    ["Everybody tiptoes around you. I have decided I am not going to.", "hostile", "dry"],
    ["Go on then. Tell me one true thing about yourself and I will drop it.", "neutral", "sly"],
    ["I have been watching you work this room all week and it is genuinely impressive.", "neutral", "sly"],
    ["You are going to be the reason somebody good goes home. I want that on record.", "hostile", "reserved"],
    ["I do not dislike you, {p}. I just think you are dangerous and I am done pretending.", "neutral", "open"],
    ["Say it to my face for once instead of to whoever is stood nearest.", "hostile", "forward"],
    ["There is a version of you that is honest. I have never met them.", "hostile", "warm"],
  ],
};

function playPool(intent: PlayIntent): Line[] {
  return [...PLAY_LINES[intent], ...PLAY_LINES_EXTRA[intent]];
}

// --- ordinary topics -------------------------------------------------------
// The spec's point: game talk is one subject among many, not the only one. The
// class pools below stay the richest source of ordinary speech because they are
// where the five voices live; these widen what a villa actually talks about.
// smallTalk is absent because it IS the class pools.

const TOPIC_LINES: Record<Exclude<Topic, "smallTalk">, Line[]> = {
  game: [
    ["Be honest, {p}. If it went to a vote tonight, whose name are people saying?", "neutral", "open"],
    ["I keep counting heads and coming up short. Do you feel that too?", "neutral", "reserved"],
    ["Nobody here is playing it straight. I just want to know who is playing hardest.", "neutral", "sly"],
    ["If we are both still here next week, {p}, it will not be by accident.", "neutral", "forward"],
    ["Whatever happens when they call the names, I would rather see it coming.", "neutral", "dry"],
    ["I am not asking you to promise me anything. I am asking you to be honest.", "friendly", "open"],
    ["Everybody says they are not playing. Everybody is playing. It is quite funny.", "neutral", "dry"],
    ["The people who last here are the ones nobody thinks about. Remember that.", "neutral", "sly"],
    ["I have never been good at this bit. The talking round it, I mean.", "neutral", "reserved"],
    ["Who do you actually rate in here? Not who you like. Who you rate.", "neutral", "forward"],
    ["I would rather go out doing something than sit still and be forgotten.", "neutral", "forward"],
    ["There is a version of this where we both go far. I have thought about it a lot.", "friendly", "warm"],
  ],
  backstory: [
    ["What did you actually do before all this? I cannot picture you in an office.", "friendly", "open"],
    ["I was the loud one in a very quiet family. It explains most of me, honestly.", "friendly", "forward"],
    ["Tell me about the version of you that nobody in this villa has met yet.", "friendly", "sly"],
    ["I nearly did not come on this show. My sister filled the form in for me.", "friendly", "warm"],
    ["Oldest, youngest, or the middle one? I can usually tell. You I cannot.", "friendly", "sly"],
    ["Who taught you to be like this? I mean that as a compliment, mostly.", "friendly", "warm"],
    ["I have had four jobs and been bad at three of them. Ask me which.", "friendly", "dry"],
    ["I was a very serious child. Everybody finds that hilarious and I do not know why.", "neutral", "reserved"],
    ["My best friend at home would not recognise me out here. That worries me a bit.", "neutral", "reserved"],
    ["Go on, worst thing you have ever been dumped over. I will match it.", "friendly", "open"],
    ["I moved eleven times before I was sixteen. I am very good at new rooms.", "neutral", "dry"],
    ["Nobody in my family watches this sort of thing. They are all watching now.", "friendly", "warm"],
  ],
  home: [
    ["I miss my own bed more than I miss any person, and I feel awful about that.", "friendly", "dry"],
    ["My mum is watching this. Hi mum. She will have opinions about my hair.", "friendly", "warm"],
    ["Do you get homesick, {p}, or are you one of the ones who never looks back?", "friendly", "open"],
    ["First thing I do when I am home is a roast dinner and twelve hours asleep.", "friendly", "warm"],
    ["There is a dog at home who thinks I abandoned him. He is not entirely wrong.", "friendly", "warm"],
    ["I did not think I would miss the rain. Turns out I miss the rain.", "neutral", "reserved"],
    ["I have not been away from my sister this long since we were children.", "neutral", "reserved"],
    ["My flat will be an absolute state. Nobody is watering anything.", "friendly", "dry"],
    ["I keep composing texts in my head to people who cannot receive them.", "neutral", "open"],
    ["Somebody at home is going to have watched every second of this. Terrifying.", "neutral", "sly"],
    ["I want one normal Tuesday. Nothing happening. Nobody being voted anywhere.", "neutral", "dry"],
    ["When I get back I am going to be insufferable about all of this for a year.", "friendly", "forward"],
  ],
  food: [
    ["Whoever is on breakfast tomorrow, it is not me. I burnt water yesterday.", "friendly", "dry"],
    ["I would trade an alliance for a proper cup of tea right now. Half joking.", "friendly", "sly"],
    ["We have eaten the same three things all week. I dream about noodles now.", "friendly", "open"],
    ["Do you cook, {p}, or are you a beans on toast at midnight kind of person?", "friendly", "open"],
    ["Somebody keeps taking the last of the mangoes and I have my suspicions.", "neutral", "sly"],
    ["Best meal you have ever eaten. Go. I need something nice to think about.", "friendly", "warm"],
    ["I have started rationing the good biscuits. That is who I am now.", "neutral", "dry"],
    ["If I have to eat rice off a paper plate one more time I will say something.", "neutral", "forward"],
    ["I made a genuinely good breakfast this morning and nobody noticed. Devastating.", "friendly", "warm"],
    ["My whole personality at home is knowing where the good places are.", "friendly", "forward"],
    ["I would like to formally request that somebody else does the washing up.", "friendly", "dry"],
    ["Come and eat with me tonight. Nothing strategic. I just hate eating alone.", "friendly", "warm"],
  ],
  weather: [
    ["This heat has beaten me. I have given up and moved into the shade permanently.", "neutral", "dry"],
    ["It rained for nine minutes last night and I nearly cried with joy.", "friendly", "warm"],
    ["I have burnt in places I did not know could burn. Please do not ask.", "friendly", "open"],
    ["The wind changed this morning. My gran would say that means something.", "neutral", "reserved"],
    ["The hour after sunset is the only time this island is bearable. Best part of my day.", "friendly", "warm"],
    ["I have drunk my body weight in water and I am somehow still thirsty.", "neutral", "dry"],
    ["It is too hot to argue with anybody. That is the only thing keeping the peace.", "neutral", "sly"],
    ["I have started planning my whole day around where the shade will be.", "neutral", "reserved"],
    ["Storm coming, I reckon. You can feel it in your teeth out here.", "neutral", "forward"],
    ["Nobody warned me about the humidity. I have made peace with my hair.", "friendly", "open"],
  ],
  setting: [
    ["That view still gets me every morning, and I still forget to actually look at it.", "friendly", "open"],
    ["There is a bird out here that screams like a car alarm at five every day.", "neutral", "dry"],
    ["This place is beautiful and completely mad, and so is everyone in it.", "friendly", "warm"],
    ["I found a path behind the pool that goes absolutely nowhere. I love it there.", "friendly", "reserved"],
    ["Cameras in the palm trees. Paradise, with an audience. What a life, {p}.", "neutral", "sly"],
    ["The sea is warmer than the shower. I have made my choice about which I use.", "friendly", "dry"],
    ["I have found the one corner of this villa nobody else goes to. It is mine now.", "neutral", "reserved"],
    ["Everything here is designed so you cannot have a private conversation. Noticed?", "neutral", "sly"],
    ["I keep expecting the walls to be fake. I knocked on one. It was real. Disappointing.", "friendly", "open"],
    ["Best thing about this island is the mornings before anybody else is up.", "friendly", "warm"],
    ["The pool is genuinely too cold and everybody is too proud to say it.", "neutral", "forward"],
    ["I want to see what is over that hill and nobody will come with me. You, {p}?", "friendly", "forward"],
  ],
  joke: [
    ["I have decided the seagulls run this villa and the rest of us are guests.", "neutral", "open"],
    ["My plan today was to look mysterious. I fell off a sunbed instead.", "friendly", "warm"],
    ["If they put me on the cooking rota again, that is a production error.", "friendly", "dry"],
    ["Say something funny, {p}. I have used all of mine and it is not even lunch.", "friendly", "forward"],
    ["I would like to formally apologize for my dancing last night. To everybody.", "friendly", "warm"],
    ["Two weeks ago I had a job. Now my entire personality is sunscreen.", "friendly", "dry"],
    ["I have been practising my shocked face for when they read the names out.", "neutral", "sly"],
    ["My strategy is to be so pleasant that voting me off looks like a crime.", "friendly", "sly"],
    ["I tried to be enigmatic this morning and somebody asked if I felt unwell.", "friendly", "open"],
    ["If I go home first I want it noted that I was extremely good at the pool.", "friendly", "forward"],
    ["Somebody has stolen my sunglasses and I intend to make it everybody's problem.", "friendly", "forward"],
    ["I have decided the villa needs a rota for who gets to be the dramatic one.", "friendly", "dry"],
  ],
  likes: [
    ["What is the thing you love that absolutely nobody would guess about you?", "friendly", "open"],
    ["You have got a great laugh, {p}. I keep saying stupid things just to hear it.", "friendly", "warm"],
    ["Give me your comfort film. I promise not to judge you for it. Much.", "friendly", "warm"],
    ["I like people who are easy to be quiet with. You are one of those.", "friendly", "reserved"],
    ["Favorite song, right now, no thinking. Mine is embarrassing so you go first.", "friendly", "open"],
    ["I have decided you are one of the good ones. That is not strategy, it is just true.", "friendly", "warm"],
    ["I am extremely competitive about board games and it has ended friendships.", "friendly", "forward"],
    ["Tell me something you are properly good at. Everybody here is too modest.", "friendly", "open"],
    ["I collect terrible souvenirs. My flat looks like a jumble sale. I love it.", "friendly", "dry"],
    ["What is your most controversial opinion? I will start us off gently.", "friendly", "sly"],
    ["I would rather be interesting than liked. Most people here want the opposite.", "neutral", "sly"],
    ["You are much funnier than you let on. I have been keeping track.", "friendly", "warm"],
  ],
};

// --- class small talk ------------------------------------------------------
// Deep per-class pools so a model-off game sounds human and rarely repeats.
// Openers land the first impression; replies carry the middle and the last word.
// Mostly human, a little strategy for seasoning. Tones match the words so the
// escalation scorer downgrades an alliance to a truce when the final line is
// hostile.
//
// These twelve per class are the ORIGINAL pools, unchanged in content, order and
// length so that the flags-off path selects exactly the line it always did. The
// only edits are the register tags (a third tuple slot, which does not move an
// index), the removal of dashes written at source, and the three truce lines
// which were swapped in place for non-truce lines of the same voice.

const OPENERS: Record<Class, Line[]> = {
  bold: [
    ["Okay, be honest, how long did you spend on that hair this morning?", "friendly", "forward"],
    ["I've decided you're interesting. That's a big deal, ask anyone.", "friendly", "forward"],
    ["This heat is criminal. I've sweat through three outfits and it isn't noon.", "neutral", "dry"],
    ["Bet I can outswim you, outtalk you and outflirt you. Name the event.", "friendly", "forward"],
    ["You've been avoiding me. Bold move. I respect it, barely.", "neutral", "sly"],
    ["Come on then, entertain me. It's been a slow, sunburnt kind of day.", "neutral", "dry"],
    ["I don't do shy. So sit down and tell me your worst secret.", "friendly", "forward"],
    ["You look like trouble. Finally, somebody worth talking to.", "friendly", "warm"],
    ["Real talk, who in this villa is getting on your last nerve?", "friendly", "sly"],
    ["Nice face. Shame you'll have to keep up with my mouth all week.", "friendly", "warm"],
    ["Everyone here is soft. You're not soft though, are you?", "neutral", "open"],
    ["Move over, I'm claiming this sunbed and half your attention.", "friendly", "warm"],
  ],
  timid: [
    ["Oh, hi. Sorry, I didn't mean to hover. You just seemed nice.", "friendly", "reserved"],
    ["Is it just me, or is this whole villa a bit much some days?", "friendly", "open"],
    ["I've been rehearsing what to say to you for an hour. This was it.", "friendly", "reserved"],
    ["I saved you the good sunbed. Don't tell the others I did that.", "friendly", "warm"],
    ["You have a kind face. That sounds weird out loud. Sorry.", "friendly", "warm"],
    ["I miss my dog more than I miss my phone. Is that bad?", "friendly", "open"],
    ["Can we just talk about nothing for a bit? I need a break from the drama.", "friendly", "reserved"],
    ["I never know where to sit at breakfast. Can I hide near you?", "friendly", "reserved"],
    ["I keep forgetting the cameras are on, then I remember and panic.", "friendly", "dry"],
    ["I'm bad at first impressions. Please pretend this one was smooth.", "friendly", "open"],
    ["Everyone's so loud here. You seem like you'd get that.", "neutral", "dry"],
    ["Do you ever want to go home and also never leave? Same.", "friendly", "warm"],
  ],
  schemer: [
    ["So. Tell me everything. Who do you actually trust in here?", "friendly", "sly"],
    ["I noticed you clock everything, same as me. We're the observant ones.", "deceptive", "sly"],
    ["Okay, gossip with me, I'm dying. What did you make of last night?", "friendly", "open"],
    ["You're far more interesting than you let people think. I like that.", "deceptive", "warm"],
    ["I brought you coffee. No agenda. Well, maybe a little curiosity.", "friendly", "warm"],
    ["Be honest, who in here is actually playing a game? I have theories.", "friendly", "forward"],
    ["You give nothing away. It's infuriating and a little bit magnetic.", "deceptive", "sly"],
    ["I feel like you and I would genuinely get each other. Try me.", "deceptive", "warm"],
    ["What's your read on the room? I trust your eyes more than mine.", "friendly", "open"],
    ["I could talk to you for hours. Start with where you're from.", "friendly", "warm"],
    ["Everyone's performing out here. You feel real. That's rare.", "deceptive", "reserved"],
    ["Come sit, spill the tea. I promise it stays between us.", "friendly", "sly"],
  ],
  charmer: [
    ["There you are. I've been saving my best story for someone worth it.", "friendly", "warm"],
    ["Genuinely, you have the best laugh in this entire villa.", "friendly", "warm"],
    ["Come here, I need a partner for the least athletic swim ever.", "friendly", "open"],
    ["You walked in and I forgot what I was saying. Rude of you, honestly.", "friendly", "forward"],
    ["I remembered you take your tea with two sugars. See? I listen.", "friendly", "warm"],
    ["Tell me one thing nobody here knows about you. I'll go first.", "friendly", "sly"],
    ["You looked a bit lost today, so I'm officially adopting you. Congrats.", "friendly", "warm"],
    ["Sunset's in an hour. Come watch it and be dramatic about home with me.", "friendly", "open"],
    ["Compliment for you, then you owe me one back. Those are the rules.", "friendly", "forward"],
    ["I could talk to anyone in here, but I keep drifting back to you.", "friendly", "warm"],
    ["Okay, new best friend interview. Question one, favorite comfort food?", "friendly", "open"],
    ["You've got a good energy. I collect those. You're mine now.", "friendly", "forward"],
  ],
  wildcard: [
    ["Quick question, if this island had a ghost, would you fight it or befriend it?", "neutral", "open"],
    ["I renamed all the seagulls. That one's Kevin. Kevin's a menace.", "neutral", "dry"],
    ["I flipped a coin about whether to talk to you. The coin lost. Hi.", "neutral", "dry"],
    ["Do you think the cameras can hear my thoughts? Asking for a reason.", "neutral", "reserved"],
    ["I've been up since four just vibing with the ocean. It gets me.", "neutral", "reserved"],
    ["Pick a number, no reason. I want to see how you decide things.", "neutral", "sly"],
    ["I dreamt we opened a smoothie stand and it failed gloriously. Thoughts?", "neutral", "warm"],
    ["Everyone's busy scheming and forgot the sand is warm and free.", "neutral", "open"],
    ["Hi. I might become your best friend or your nemesis. Coin's still spinning.", "deceptive", "sly"],
    ["What's the weirdest thing you'd admit to a stranger? Go, right now.", "neutral", "forward"],
    ["Come do something gloriously pointless with me before the drama restarts.", "neutral", "warm"],
    ["You seem normal. Suspicious. Let's fix that immediately.", "neutral", "forward"],
  ],
};

const REPLIES: Record<Class, Line[]> = {
  bold: [
    ["Ha, okay, you're funnier than you look. Don't let it go to your head.", "friendly", "warm"],
    ["See, now we're talking. I knew you had a spine somewhere.", "friendly", "forward"],
    ["Fine, you win this round. Rematch at breakfast, I'm not done.", "friendly", "forward"],
    ["I like you, and that's rare, so enjoy it while it lasts.", "friendly", "warm"],
    ["Careful, keep being this real and I might actually trust you.", "neutral", "open"],
    ["Nah, you're alright. The rest of them, jury's still out.", "neutral", "dry"],
    // Was a truce line. Same voice, no pact in it.
    ["Right, I've said my bit. You can stop bracing now.", "friendly", "dry"],
    ["Deal. Just keep up, I don't slow down for anybody.", "neutral", "forward"],
    ["Push me again and it stops being playful. Just so we're clear.", "hostile", "forward"],
    ["Save the sweet talk. I've heard smoother, and they went home first.", "hostile", "sly"],
    ["You bore me now. Go be somebody else's problem.", "hostile", "dry"],
    ["Talk to me like that again and we're going to have a real problem.", "hostile", "forward"],
  ],
  timid: [
    ["Oh good, I was so scared you'd be one of the mean ones.", "friendly", "reserved"],
    ["That actually made me laugh. I needed that today, thank you.", "friendly", "warm"],
    ["Okay, I trust you a little now. That's huge for me, honestly.", "friendly", "open"],
    ["Can we be the ones who don't do the shouting thing? Please?", "friendly", "reserved"],
    ["I'll remember you were kind to me. I remember everything.", "friendly", "warm"],
    // Was a truce line. Same voice, no pact in it.
    ["Less shouting, more surviving. That's genuinely my whole plan.", "friendly", "dry"],
    ["You don't have to look out for me, but it's sweet that you offered.", "friendly", "warm"],
    ["Sorry, I'm rambling. You're just really easy to talk to.", "friendly", "open"],
    ["Let's both just stay out of trouble, okay? Deal?", "neutral", "reserved"],
    ["I think you might be my favorite person here. Don't tell anyone.", "friendly", "warm"],
    ["Okay, I'll stop worrying for five whole minutes. For you.", "friendly", "open"],
    ["Please don't turn on me later. I don't think I could take it.", "friendly", "reserved"],
  ],
  schemer: [
    ["See, I knew you were one of the sharp ones. This is nice.", "deceptive", "sly"],
    ["I mean every word of that. Mostly. Don't read the fine print.", "deceptive", "dry"],
    ["You're good company, genuinely. The gossip can wait, this is fun.", "friendly", "warm"],
    ["Between us and the seagulls, that's exactly what I thought too.", "friendly", "sly"],
    ["Stick with me and the drama always seems to land on someone else.", "deceptive", "sly"],
    ["Look at us, thick as thieves already. I do love a project.", "deceptive", "forward"],
    ["I'll keep your secrets. Every last delicious one of them.", "deceptive", "sly"],
    ["Careful, I could actually start liking you, and that ruins my whole thing.", "deceptive", "warm"],
    ["Yeah, let's look out for each other. I'm watching everything else too.", "deceptive", "open"],
    ["Okay, no games right now. I just genuinely like talking to you.", "friendly", "reserved"],
    ["You're my favorite bit of this whole circus, you know that?", "friendly", "warm"],
    ["Trust me on this one. I'm almost always right about people.", "deceptive", "forward"],
  ],
  charmer: [
    ["See? Told you we'd click. I'm never wrong about people, it's annoying.", "friendly", "forward"],
    ["Okay you're officially adopted, no refunds, welcome to the family.", "friendly", "warm"],
    ["Stop being this lovely, the cameras are going to ship us.", "friendly", "warm"],
    ["I've got you, honestly. That's not a strategy, I just like you.", "friendly", "open"],
    ["This is my favorite conversation all week and it's only breakfast.", "friendly", "warm"],
    ["Come on, one more story, then I'll let you go be popular elsewhere.", "friendly", "forward"],
    ["You and me at that sunset later. Don't you dare flake on me.", "friendly", "forward"],
    ["I'll keep you smiling if you keep me sane. Fair trade, sunshine.", "friendly", "warm"],
    ["Locked in as friends. Now try to keep up with my social calendar.", "friendly", "sly"],
    ["I mean it, you're a bright spot in a very sweaty week.", "friendly", "warm"],
    ["Deal. Loud laughs, good angles, zero drama between us.", "friendly", "dry"],
    ["You're stuck with me now, and I'm very hard to get rid of.", "friendly", "forward"],
  ],
  wildcard: [
    ["Ha, correct answer. We're friends now. The coin has spoken.", "neutral", "warm"],
    ["See, this is why I like you. You don't flinch at the weird stuff.", "friendly", "open"],
    ["I like you today. Ask me again after lunch, no promises.", "neutral", "dry"],
    ["Okay, you passed the vibe check. Barely. Kevin the seagull agrees.", "neutral", "dry"],
    ["Let's go do something chaotic and harmless before someone starts drama.", "neutral", "forward"],
    ["Yes. No. Both. I already forgot what we agreed on, but I'm in.", "neutral", "open"],
    ["Friends it is, until the wind changes and I ruin it spectacularly.", "deceptive", "sly"],
    ["You're weird, and I mean that as the highest compliment I've got.", "friendly", "warm"],
    // Was a truce line. Same voice, no pact in it.
    ["I have absolutely no idea what we just agreed. I liked it though.", "neutral", "reserved"],
    ["Cool cool cool. Now watch me overthink this for absolutely no reason.", "neutral", "reserved"],
    ["My gut says trust you. My gut also wanted three lunches, so, grain of salt.", "neutral", "dry"],
    ["I'll help you. Probably. Unless a shinier idea distracts me first.", "neutral", "sly"],
  ],
};

// --- class pool extensions -------------------------------------------------
// Appended to the pools above only when conversationVariety is on, which is what
// lets the twelve originals keep their exact indices on the flags-off path while
// the shipped game speaks from a pool more than twice the size. Twelve lines
// across a fifty islander cast was the arithmetic behind "they say the same
// things consistently"; these are the budget for fixing it.

const OPENERS_EXTRA: Record<Class, Line[]> = {
  bold: [
    ["Right, I have watched you for two days and I still cannot read you. Explain yourself.", "friendly", "forward"],
    ["I am going to be very direct because I am incapable of the other thing.", "neutral", "forward"],
    ["You are the only person here who has not tried to charm me. I noticed.", "neutral", "sly"],
    ["I have had an opinion about you since day one. Want to hear it?", "friendly", "sly"],
    ["Sit. I am in the mood for an argument and you look like you would enjoy one.", "friendly", "forward"],
    ["Everybody else is whispering. I would rather just say things at normal volume.", "neutral", "open"],
    ["I saw what you did at the challenge. Do not go modest on me now.", "friendly", "warm"],
    ["Tell me something true. I am collecting them, this place is short on them.", "neutral", "open"],
    ["I have decided we are going to be either very close or a problem. Pick.", "friendly", "warm"],
    ["You look like you have been thinking too hard. Come be loud with me instead.", "friendly", "warm"],
  ],
  timid: [
    ["Is this seat taken? Sorry. I will move if it is. I will move anyway.", "friendly", "reserved"],
    ["I have been meaning to say hello for three days and kept losing my nerve.", "friendly", "reserved"],
    ["You always seem calm. How do you do that? Teach me, genuinely.", "friendly", "open"],
    ["I brought two drinks in case you were here. That is not weird, is it?", "friendly", "warm"],
    ["I do not really do the big group thing. This is much better.", "neutral", "reserved"],
    ["Can I ask you something and you promise not to repeat it?", "friendly", "sly"],
    ["Everybody is so certain about everything. I am not certain about anything.", "neutral", "open"],
    ["I like that you do not fill every silence. Most people here cannot help it.", "friendly", "dry"],
    ["I keep a little list of who has been nice to me. You are on it.", "friendly", "warm"],
    ["I nearly cried at breakfast over absolutely nothing. Ignore me. Hello.", "friendly", "dry"],
  ],
  schemer: [
    ["Walk with me. I would rather this was not said where people can count us.", "deceptive", "sly"],
    ["You are the most underrated person in this villa and I do not think you know it.", "deceptive", "warm"],
    ["Small thing. Have you noticed who has stopped talking to who this week?", "neutral", "sly"],
    ["I want to run something past you and I want your honest face, not the polite one.", "friendly", "open"],
    ["I have a theory about this whole place and you are the only one I would tell.", "deceptive", "sly"],
    ["What do you make of the way that went last night? Nobody else will say.", "neutral", "open"],
    ["I am going to be unusually honest with you and then never mention it again.", "deceptive", "reserved"],
    ["You and I have never actually had a proper conversation. That is on me.", "friendly", "warm"],
    ["I notice things. I noticed you noticing them too. That is a rare thing here.", "deceptive", "forward"],
    ["Do not answer straight away. Just think about who benefits from all this.", "neutral", "forward"],
  ],
  charmer: [
    ["Stop, sit, tell me everything. I have had a boring morning and you are the cure.", "friendly", "warm"],
    ["You have been the best part of this week and I do not think you have noticed.", "friendly", "warm"],
    ["I am going to make you laugh in under a minute. Start the clock.", "friendly", "forward"],
    ["Come on, walk with me, I want to hear about the thing you never talk about.", "friendly", "open"],
    ["I saved you a mango. This is the highest form of love available on this island.", "friendly", "warm"],
    ["You look far too serious for this hour. Tell me what is going on.", "friendly", "open"],
    ["If we get to the end of this and are not still friends I will be very hurt.", "friendly", "warm"],
    ["I have decided today is a good day and you are going to help me prove it.", "friendly", "forward"],
    ["Right, favourite person check in. How are you, actually?", "friendly", "warm"],
    ["Nobody has said anything nice to you today, have they. Let me fix that.", "friendly", "sly"],
  ],
  wildcard: [
    ["If you had to be a piece of furniture in this villa, what and why. Go.", "neutral", "open"],
    ["I have been awake since three thinking about crabs. Do you want to hear it?", "neutral", "dry"],
    ["I have decided today has a colour and the colour is beige. Fight me.", "neutral", "forward"],
    ["Nobody has asked me a single interesting question all week. Your turn.", "neutral", "forward"],
    ["I am doing an experiment where I tell everyone the truth. You are number four.", "neutral", "sly"],
    ["The palm tree by the gate is judging us. I have made my peace with it.", "neutral", "dry"],
    ["Do you ever think about how strange it is that we are all just here?", "neutral", "reserved"],
    ["I have started keeping a diary and it is entirely about other people's hair.", "neutral", "sly"],
    ["Come look at this thing I found. It is not important. It is quite good though.", "neutral", "warm"],
    ["I am in a very odd mood and I would like a witness. Sit down.", "neutral", "reserved"],
  ],
};

const REPLIES_EXTRA: Record<Class, Line[]> = {
  bold: [
    ["Good. That is the first straight answer anyone has given me all week.", "friendly", "forward"],
    ["I will take that. You are not as safe as you look and I like it.", "friendly", "sly"],
    ["Do not soften it for me. I would rather have it sharp and true.", "neutral", "forward"],
    ["Right, well now I have to respect you. Very inconvenient.", "friendly", "warm"],
    ["That is either brilliant or completely mad. I am in either way.", "friendly", "open"],
    ["You are braver than people give you credit for. Do not let them forget it.", "friendly", "warm"],
    ["I do not agree with a word of that and I am glad you said it.", "neutral", "open"],
    ["Enough talking. Let us go and actually do something about it.", "neutral", "forward"],
    ["Careful. That is the kind of thing you cannot take back later.", "neutral", "dry"],
    ["Say it louder next time. Half of them need to hear it.", "friendly", "forward"],
  ],
  timid: [
    ["That is such a relief to hear. I have been carrying it around all week.", "friendly", "reserved"],
    ["I did not expect you to be this easy to talk to. Sorry, that came out wrong.", "friendly", "open"],
    ["Can we do this again tomorrow? Not the drama. Just the sitting.", "friendly", "warm"],
    ["I will not say anything to anyone. I am very good at not saying things.", "friendly", "sly"],
    ["Thank you. Properly. I know that is a small thing but it was not to me.", "friendly", "warm"],
    ["I always think of the right answer about an hour after the conversation.", "neutral", "dry"],
    ["I do not think I am built for this place. I am going to try anyway.", "neutral", "reserved"],
    ["Is it alright if I sit here a bit longer and not talk?", "friendly", "reserved"],
    ["You are much kinder than you let people see. I have been watching.", "friendly", "warm"],
    ["Okay. I feel better. I do not know why that worked but it worked.", "friendly", "open"],
  ],
  schemer: [
    ["Keep that between us and it stays useful. Say it out loud and it is worthless.", "deceptive", "sly"],
    ["I had the same read and I was starting to think I was going mad.", "friendly", "open"],
    ["Interesting. File that away. It will matter in about a week.", "deceptive", "sly"],
    ["You are better at this than you are pretending to be, and I like that.", "deceptive", "warm"],
    ["I am going to do nothing about it for now. That is the clever move.", "neutral", "reserved"],
    ["Whatever happens, remember I told you first. That is all I want.", "deceptive", "forward"],
    ["No, you are right, and I hate that you are right.", "friendly", "dry"],
    ["Do not change how you behave around them. That is how people notice.", "deceptive", "sly"],
    ["I would back you. I want that said before it becomes convenient to say it.", "deceptive", "warm"],
    ["Everybody in here underestimates you. Long may it continue.", "deceptive", "forward"],
  ],
  charmer: [
    ["See, this is exactly why I like you. Nobody else says it like that.", "friendly", "warm"],
    ["Right, that settles it. You are coming to sit with me every morning now.", "friendly", "forward"],
    ["I could listen to you talk about that for another hour. Genuinely.", "friendly", "warm"],
    ["You have made my entire day and it is not even lunchtime.", "friendly", "warm"],
    ["Do not let this place make you smaller. I will be very annoyed.", "friendly", "open"],
    ["That is going straight in my favourite things anybody has said list.", "friendly", "warm"],
    ["I am going to be insufferable about how right I was about you.", "friendly", "forward"],
    ["Come find me later. I mean that, not in the polite way people say it.", "friendly", "warm"],
    ["You are allowed to be difficult with me. I would probably like you more.", "friendly", "sly"],
    ["Nobody is being honest today except you. Thank you for that.", "friendly", "open"],
  ],
  wildcard: [
    ["Wrong answer, but a beautiful one. I am keeping it.", "neutral", "dry"],
    ["That has completely reorganised my afternoon and I am not being sarcastic.", "neutral", "open"],
    ["I am going to think about that at four in the morning. Thanks a lot.", "neutral", "dry"],
    ["Agreed, provisionally, pending my mood changing entirely without warning.", "neutral", "sly"],
    ["Yes. Absolutely. I have no idea what we are talking about but yes.", "neutral", "forward"],
    ["You are the only sensible person here and that is genuinely worrying.", "neutral", "reserved"],
    ["Let us never discuss this again. It was perfect. It would only get worse.", "neutral", "warm"],
    ["I have written that down in my head next to the thing about the crabs.", "neutral", "reserved"],
    ["That is the correct answer and you will never get another one from me.", "neutral", "forward"],
    ["I like you. That is not a strategy, I am just quite easily won over.", "friendly", "warm"],
  ],
};

// --- sentence shape --------------------------------------------------------
// The same sentence in a different mouth. A clipped speaker drops the trailing
// half of a two sentence line; a rambling one runs on past the end of it. These
// are the cheapest way to make two islanders drawing from the same pool still
// sound unlike each other, and they cost no new lines to write.

const RAMBLE_TAGS = [
  "Anyway.",
  "You know?",
  "Sorry, I do go on.",
  "Ignore me.",
  "That probably made no sense.",
  "I have thought about this a lot, clearly.",
  "Right. Yes.",
  "That is all I had, really.",
];

const QUESTION_TAGS = [
  "Or am I reading it wrong?",
  "You think?",
  "Am I mad?",
  "Does that track for you?",
  "Or is that just me?",
  "What do you reckon?",
];

// --- voice -----------------------------------------------------------------
// Which slice of a pool an islander reaches for, and what shape its sentences
// come out in. Derived from stats and persona, both of which the server has been
// putting on the context all along and which nothing in this file ever read.

type Voice = {
  registers: Register[];
  shape: "clipped" | "plain" | "rambling";
  questioning: boolean;
  // Stable per agent, so a transform choice can be biased by identity rather
  // than only by the draw.
  seed: number;
};

// A cheap stable hash so an islander's persona actually reaches its voice. Not
// cryptographic and does not need to be; it needs to be the same every time for
// the same string, so a seeded replay reproduces the same speech.
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Stats do not change over a run, so a voice is computed once per islander. The
// cache is bounded the same way the recently-said ring is, for the same reason:
// nothing in a long lived server process may grow without a ceiling.
const voiceCache = new Map<string, Voice>();
const VOICE_CACHE_CAP = 512;

function voiceOf(ctx: AgentContextView): Voice {
  const cached = voiceCache.get(ctx.self.id);
  if (cached) return cached;

  const s = ctx.self.stats;
  const seed = hashString(`${ctx.self.id}|${ctx.self.name}|${ctx.self.persona}`);

  // Three axes, one register each, so every islander gets a three way slice of
  // any pool rather than the whole of it. Assertive comes off resolve and
  // charisma together because either one on its own is enough to make somebody
  // speak up; warmth off charm; the sly register off cunning.
  const registers: Register[] = [
    s.resolve >= STAT_HIGH || s.charisma >= STAT_HIGH ? "forward" : "reserved",
    s.charm >= STAT_HIGH ? "warm" : "dry",
    s.cunning >= STAT_HIGH ? "sly" : "open",
  ];

  const shape: Voice["shape"] =
    s.resolve >= STAT_HIGH && s.charisma <= STAT_LOW
      ? "clipped"
      : s.charisma >= STAT_HIGH && s.resolve <= STAT_LOW
        ? "rambling"
        : "plain";

  const voice: Voice = {
    registers,
    shape,
    questioning: s.instinct >= STAT_HIGH || s.cunning >= STAT_HIGH,
    seed,
  };

  if (voiceCache.size >= VOICE_CACHE_CAP) {
    const oldest = voiceCache.keys().next().value;
    if (oldest !== undefined) voiceCache.delete(oldest);
  }
  voiceCache.set(ctx.self.id, voice);
  return voice;
}

// Reshape a rendered line to suit the speaker. Never introduces a dash of any
// kind, because islander speech carries none and the sanitizer downstream is a
// guarantee rather than a licence to be careless up here.
function reshape(text: string, voice: Voice, rand: () => number): string {
  let out = text;

  if (voice.shape === "clipped") {
    // Keep the first sentence and drop the rest, but only on a line long enough
    // that dropping half of it is a style and not a truncation, and only when
    // what is left still stands on its own. A three word fragment is not a
    // clipped voice, it is a broken line, and a short line clipped to its first
    // clause also throws away whatever the second clause was substituting in.
    const end = out.search(/[.!?]\s/);
    if (out.length >= 90 && end >= 45) out = out.slice(0, end + 1);
  } else if (voice.shape === "rambling" && rand() < 0.45) {
    const tag = RAMBLE_TAGS[(voice.seed + Math.floor(rand() * RAMBLE_TAGS.length)) % RAMBLE_TAGS.length]!;
    out = `${out} ${tag}`;
  }

  if (voice.questioning && !out.includes("?") && rand() < 0.2) {
    const tag = QUESTION_TAGS[(voice.seed + Math.floor(rand() * QUESTION_TAGS.length)) % QUESTION_TAGS.length]!;
    out = `${out} ${tag}`;
  }

  return out.length > 160 ? text.slice(0, 160) : out;
}

// --- cross conversation memory ---------------------------------------------
// The pre-spec de-dup set was built from the CURRENT transcript only, so a line
// could not repeat two turns apart but could and did repeat every conversation
// for a whole run. This is the missing half: a per agent ring of line ids that
// spans conversations. Ids are pool key plus index rather than rendered text, so
// the same template said to a different partner still counts as a repeat, which
// is what a viewer actually notices.

const recentlySaid = new Map<string, string[]>();
const SPEAKER_CAP = 512;

function ringFor(agentId: string): string[] {
  const existing = recentlySaid.get(agentId);
  if (existing) return existing;
  if (recentlySaid.size >= SPEAKER_CAP) {
    const oldest = recentlySaid.keys().next().value;
    if (oldest !== undefined) recentlySaid.delete(oldest);
  }
  const fresh: string[] = [];
  recentlySaid.set(agentId, fresh);
  return fresh;
}

function remember(agentId: string, id: string): void {
  const ring = ringFor(agentId);
  ring.push(id);
  const window = Math.max(0, Math.floor(tunables.swarm.recentlySaidWindow));
  if (ring.length > window) ring.splice(0, ring.length - window);
}

// Fragments this agent has already passed on. The authoritative record lives
// server side as OverheardFragment.fresh, but the server only clears it through
// markOverheardShared, which fires when a conversation STARTS rather than when a
// fragment actually reaches a line. Until a markOverheardSpoken seam exists for
// the swarm to call, this local set is what stops one islander repeating the
// same overheard scrap in every conversation it has.
const gossipSpoken = new Set<string>();
const GOSSIP_SPOKEN_CAP = 2048;

function fragmentKey(listenerId: string, f: OverheardFragment): string {
  return `${listenerId}|${f.speakerId}|${f.t}`;
}

// Clear every per agent speech memory. Called on a game reset so a new run does
// not inherit the previous one's ring, which would silently narrow the pools an
// islander can reach on its opening lines.
export function resetRuleSpeechMemory(): void {
  recentlySaid.clear();
  voiceCache.clear();
  gossipSpoken.clear();
}

// --- reading the exchange --------------------------------------------------

// What a line sounded like. Prefer the tone the producing backend recorded; fall
// back to reading the words when it is absent, which it is for every line
// written before TranscriptLine carried a tone and for any producer that does
// not set it. A wrong guess here costs one slightly odd reply, never a crash.
const HOSTILE_MARKERS =
  /\b(problem|threat|liar|lying|lied|hate|betray|snake|played us|do not buy|nowhere left|bore me|shut up|coming for|out for me|do not trust)\b/i;
const WARM_MARKERS = /\b(love|lovely|kind|thank you|glad|friends|favourite|favorite|sweet|adore|proud)\b/i;

function inferTone(text: string): Tone {
  if (HOSTILE_MARKERS.test(text)) return "hostile";
  if (WARM_MARKERS.test(text)) return "friendly";
  return "neutral";
}

function toneOf(line: TranscriptLine): Tone {
  return line.tone ?? inferTone(line.text);
}

// The last thing the OTHER person said, which is the thing a reply is a reply
// to. Returns null on the opening line of an exchange.
function partnerLastLine(transcript: TranscriptLine[], selfName: string): TranscriptLine | null {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const l = transcript[i];
    if (l && l.speaker !== selfName) return l;
  }
  return null;
}

// How this agent answers what was just said to it. Only fires on a tone that
// demands an answer: a friendly or neutral line leaves the ordinary intent in
// charge, which is right, because most of a conversation is not a confrontation.
function readReaction(ctx: AgentContextView, last: TranscriptLine | null): ReactIntent | null {
  if (!last) return null;
  const tone = toneOf(last);
  if (tone === "hostile") {
    // Which way an islander breaks under a hostile line is temperament, not
    // situation. The bold and the scheming come back at it; the timid and the
    // charming take the heat out of it.
    switch (ctx.self.klass) {
      case "bold":
      case "schemer":
      case "wildcard":
        return "rebuff";
      default:
        return "placate";
    }
  }
  // A smooth, deniable line gets doubted by the classes built to notice, and
  // taken at face value by the ones that are not.
  if (tone === "deceptive" && (ctx.self.klass === "schemer" || ctx.self.klass === "bold")) {
    return "doubt";
  }
  return null;
}

// What the partner's last line was about, so a reply can stay on the subject
// instead of changing it every turn. Deliberately a small keyword map rather
// than anything clever: the goal is that a question about home gets an answer
// about home, not topic modelling.
const TOPIC_KEYWORDS: [Exclude<Topic, "smallTalk">, RegExp][] = [
  ["home", /\b(home|mum|mother|dad|family|sister|brother|dog|bed|flat|miss)\b/i],
  ["food", /\b(eat|eating|food|breakfast|dinner|cook|cooking|tea|mango|noodles|biscuit)\b/i],
  ["weather", /\b(heat|hot|rain|sun|sunburn|shade|wind|storm|humid|thirsty)\b/i],
  ["setting", /\b(view|villa|pool|sea|island|palm|camera|beach|path|hill)\b/i],
  ["backstory", /\b(before all this|job|grew up|childhood|school|family|work|used to)\b/i],
  ["joke", /\b(funny|laugh|joke|ridiculous|hilarious|dancing)\b/i],
  ["likes", /\b(favourite|favorite|love|song|film|music|good at)\b/i],
  ["game", /\b(vote|votes|voting|alliance|numbers|names|game|playing|count)\b/i],
];

function carriedTopic(last: TranscriptLine | null): Exclude<Topic, "smallTalk"> | null {
  if (!last) return null;
  for (const [topic, re] of TOPIC_KEYWORDS) if (re.test(last.text)) return topic;
  return null;
}

function relationshipWith(
  ctx: AgentContextView,
  partner: NearbyAgent | null,
): RelationshipSummary | null {
  if (!partner) return null;
  return (ctx.relationships ?? []).find((r) => r.id === partner.id) ?? null;
}

function isGrudge(rel: RelationshipSummary | null): boolean {
  if (!rel) return false;
  return (
    rel.threat >= GRUDGE_THREAT ||
    rel.trust <= GRUDGE_TRUST ||
    rel.recent.some((o) => o === "fight" || o === "tension" || o === "witnessedKill")
  );
}

function isWarm(rel: RelationshipSummary | null): boolean {
  if (!rel) return false;
  return rel.trust >= WARM_TRUST || rel.recent.some((o) => o === "alliance" || o === "amicable");
}

// Something the villa just went through. Reads the feed events the server has
// been attaching and nothing has ever read, and falls back to the world posture
// so the intent still exists on a build whose death and purge producers have not
// landed yet.
function inAftermath(ctx: AgentContextView): boolean {
  if (!tunables.flags.worldAwareness) return false;
  if (ctx.world?.posture === "justPassed" || ctx.world?.posture === "active") return true;
  return (ctx.recentEvents ?? []).some(
    (e) => e.kind === "death" || e.kind === "purge" || e.kind === "voteResult" || e.kind === "hostile",
  );
}

// The freshest thing this agent overheard and has not yet passed on.
//
// Whether it passes it on at all is personality times the room: a schemer with
// something juicy will not say it in front of a crowd, and the bold and the
// charming are at their most talkative when there is an audience. That is the
// spec's "crowded versus secluded changes behavior in a way that depends on
// personality" arriving in speech rather than only in movement.
function freshGossip(ctx: AgentContextView, rand: () => number): OverheardFragment | null {
  if (!tunables.flags.gossip) return null;
  const frags = ctx.overheard;
  if (!frags || frags.length === 0) return null;

  const decayMs = tunables.overhear.shareDecayMs;
  const newest = frags[frags.length - 1]!;
  const age = newest.heardAt != null ? Date.now() - newest.heardAt : 0;
  // A fragment nobody remembers is not gossip. `heardAt` may be absent on a
  // producer that has not landed yet, in which case age reads as 0 and the
  // fragment is treated as current, which is the safe direction.
  if (decayMs > 0 && age > decayMs) return null;

  let chance = 0.5;
  if (tunables.flags.spatialBehavior && ctx.spatial) {
    const mul =
      ctx.spatial.density === "crowded"
        ? tunables.spatial.crowdedMultipliers[ctx.self.klass]
        : ctx.spatial.density === "secluded"
          ? tunables.spatial.secludedMultipliers[ctx.self.klass]
          : 1;
    chance *= mul ?? 1;
  }
  if (rand() >= Math.min(1, chance)) return null;

  for (let i = frags.length - 1; i >= 0; i--) {
    const f = frags[i]!;
    if (!f.fresh) continue;
    if (gossipSpoken.has(fragmentKey(ctx.self.id, f))) continue;
    return f;
  }
  return null;
}

// Read the pair and the world, and name what this line is actually about.
//
// The first six cases are the pre-spec reading, unchanged and in the same order.
// The awareness intents are interleaved by urgency rather than appended: a death
// that just landed outranks a grudge, a grudge outranks ordinary allied warmth,
// and gossip sits just above small talk because it is what an islander reaches
// for when there is nothing more pressing to say.
function readIntent(
  ctx: AgentContextView,
  partner: NearbyAgent | null,
  rel: RelationshipSummary | null,
  gossip: OverheardFragment | null,
): Intent {
  const event = ctx.event?.kind;
  if (event === "hostile") return "hostile";
  if (partner?.allied && partner.hpFraction < LOW_HP) return "allyHurt";
  if (inAftermath(ctx)) return "aftermath";
  if (partner && !partner.allied && isGrudge(rel)) return "grudge";
  if (partner?.allied) return "ally";
  if (partner && (partner.notoriety >= NOTORIOUS || partner.kills >= 2)) return "wary";
  if (event === "purge" || event === "weakestLink") return "campaign";
  if (ctx.self.hpFraction < LOW_HP) return "vulnerable";
  if (gossip) return "gossip";
  if (partner && isWarm(rel)) return "warmth";
  return "small";
}

// The pre-spec reading, kept verbatim for the flags-off path. Identical to
// readIntent minus every awareness case, so a build with conversationVariety off
// selects exactly the pool it always did.
function readIntentLegacy(
  ctx: AgentContextView,
  partner: NearbyAgent | null,
): LegacyIntent | "small" {
  const event = ctx.event?.kind;
  if (event === "hostile") return "hostile";
  if (partner?.allied) return partner.hpFraction < LOW_HP ? "allyHurt" : "ally";
  if (partner && (partner.notoriety >= NOTORIOUS || partner.kills >= 2)) return "wary";
  if (event === "purge" || event === "weakestLink") return "campaign";
  if (ctx.self.hpFraction < LOW_HP) return "vulnerable";
  return "small";
}

// Every substitution a line can carry. Widened from the original three so the
// awareness pools can name what they are actually about: who was overheard, what
// they said, and how many of us are left.
type Vars = {
  p: string;
  s: string;
  t?: string | null;
  g?: string | null;
  q?: string | null;
  n?: string | null;
};

function fill(text: string, v: Vars): string {
  return (
    text
      .replaceAll("{p}", v.p)
      .replaceAll("{s}", v.s)
      // A line that names a third party is only ever chosen when there is one;
      // "somebody" is the safe read if that ever stops being true.
      .replaceAll("{t}", v.t ?? "somebody")
      .replaceAll("{g}", v.g ?? "somebody")
      .replaceAll("{q}", v.q ?? "it was nothing good")
      .replaceAll("{n}", v.n ?? "a few")
  );
}

// The number of living islanders as a word, because an islander counting the
// room says "four of us", never "4".
const NUMBER_WORDS = [
  "nobody",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];

function spokenCount(n: number | undefined): string | null {
  if (n == null || n < 0) return null;
  return NUMBER_WORDS[n] ?? `${n}`;
}

// A short, quotable piece of an overheard line. Cut at a word boundary and
// stripped of its closing punctuation so it sits inside a quoting sentence.
function quotable(text: string, limit = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat.replace(/[.!?,]+$/, "");
  // A whole short sentence is what somebody actually carries away from a line
  // they half heard, so prefer one over an arbitrary slice of two.
  const end = flat.search(/[.!?]\s/);
  if (end >= 15 && end < limit) return flat.slice(0, end);
  const head = flat.slice(0, limit);
  const cut = head.lastIndexOf(" ");
  return (cut > 20 ? head.slice(0, cut) : head).replace(/[.!?,]+$/, "");
}

// The behavior-spec plays, checked ahead of ordinary talk but behind anything
// urgent. Each is gated on its own flag and returns null when it does not fire,
// so with the flags off pool selection is exactly what it was. Note the
// deliberate care never to draw from `rand` on a disabled path: the balance
// harness relies on the same context and seed producing the same run.
function readPlay(
  ctx: AgentContextView,
  partner: NearbyAgent | null,
  rand: () => number,
): { intent: PlayIntent; thirdParty: string | null } | null {
  // Saving yourself from tonight's vote comes before working tomorrow's.
  const plan = deflectionPlan(ctx);
  if (plan) return { intent: "deflect", thirdParty: plan.toward?.name ?? null };

  // Making the case needs an actual case: a name this agent could move on, and
  // a reason the villa would be discussing it at all.
  const votePressure =
    ctx.world?.posture === "imminent" ||
    ctx.world?.posture === "active" ||
    ctx.event?.kind === "weakestLink" ||
    ctx.event?.kind === "purge";
  if (votePressure) {
    const mark = rankVoteTargets(ctx).find((v) => v.feasible && v.id !== partner?.id);
    if (mark) return { intent: "voteCase", thirdParty: mark.name };
  }

  // Stirring something up. The warmup ramp lives inside conflictChance, so this
  // is rare in the opening and ordinary later, and a timid islander mostly
  // never gets here at all.
  if (
    tunables.flags.earlyAggression &&
    partner &&
    !partner.allied &&
    rand() < conflictChance(ctx)
  ) {
    return { intent: "needle", thirdParty: null };
  }
  return null;
}

// Pick one line out of a pool.
//
// Four filters, each one narrowing only when it can do so without emptying the
// set: the speaker's registers, then the lines already said in this exchange,
// then the lines this speaker has used recently in ANY exchange. Exactly one
// draw from `rand` regardless of how the filters land, which is what keeps the
// seeded harness reproducible.
type Picked = { text: string; tone: Tone; id: string };

function choosePooled(
  key: string,
  pool: Line[],
  voice: Voice | null,
  said: Set<string>,
  ring: string[] | null,
  render: (raw: string) => string,
  rand: () => number,
): Picked {
  let cand = pool.map((_, i) => i);

  if (voice) {
    const byRegister = cand.filter((i) => {
      const r = pool[i]![2];
      return r === undefined || voice.registers.includes(r);
    });
    if (byRegister.length > 0) cand = byRegister;
  }

  const unsaid = cand.filter((i) => !said.has(render(pool[i]![0])));
  if (unsaid.length > 0) cand = unsaid;

  // The ring is ONE flat window across every pool this speaker draws from, so a
  // pool the register filter has narrowed to a handful can have all of its
  // candidates sitting inside the window at once. A plain "drop anything in the
  // ring, and give up if that empties the set" degrades to a uniform draw over
  // the whole pool at exactly the moment repetition is most likely, which
  // measured as the same line twice three turns apart.
  //
  // Keeping the LEAST recently said candidates instead subsumes both cases in
  // one rule: a line absent from the ring ranks ahead of every line in it, and
  // among lines that are in it the oldest wins. When the pool is not exhausted
  // this picks from exactly the unsaid set as before; when it is, it walks the
  // pool round robin rather than collapsing, which is the widest spacing the
  // pool can offer.
  if (ring && ring.length > 0) {
    let oldest = Infinity;
    const lastSaidAt = new Map<number, number>();
    for (const i of cand) {
      const at = ring.lastIndexOf(`${key}#${i}`);
      lastSaidAt.set(i, at);
      if (at < oldest) oldest = at;
    }
    const stalest = cand.filter((i) => lastSaidAt.get(i) === oldest);
    if (stalest.length > 0) cand = stalest;
  }

  const idx = cand[Math.floor(rand() * cand.length)] ?? cand[0] ?? 0;
  const line = pool[idx] ?? pool[0]!;
  return { text: render(line[0]), tone: line[1], id: `${key}#${idx}` };
}

// A spoken line together with the reading that produced it.
//
// The second half matters on the resolve turn. The outcome of an encounter
// should follow the conversation that actually happened, not a fresh reading of
// the same context, because the two can disagree: `freshGossip` consumes the
// fragment it returns, so a re-read after the line has been spoken can never see
// the gossip intent again and that whole branch of the outcome chooser was
// unreachable. Carrying the intent forward also spares a second readIntent call.
type Spoken = { line: Line; intent: Intent };

// The pre-spec speaker, kept whole. Reached when conversationVariety is off, and
// byte-identical in behavior to what shipped: same pools, same filter, same
// single draw from `rand`.
function speakLegacy(
  ctx: AgentContextView,
  partner: NearbyAgent | null,
  partnerName: string,
  transcript: TranscriptLine[],
  rand: () => number,
): Spoken {
  const intent = readIntentLegacy(ctx, partner);
  const play = intent === "small" || intent === "campaign" ? readPlay(ctx, partner, rand) : null;

  let thirdParty: string | null = null;
  let key: string;
  let pool: Line[];
  if (play) {
    key = `play:${play.intent}`;
    pool = PLAY_LINES[play.intent];
    thirdParty = play.thirdParty;
  } else if (intent !== "small") {
    key = `intent:${intent}`;
    pool = INTENT_LINES[intent];
  } else {
    key = transcript.length === 0 ? `open:${ctx.self.klass}` : `reply:${ctx.self.klass}`;
    pool = transcript.length === 0 ? OPENERS[ctx.self.klass] : REPLIES[ctx.self.klass];
  }

  const render = (raw: string) =>
    fill(raw, { p: partnerName, s: ctx.self.name, t: thirdParty }).slice(0, 160);
  const said = new Set(transcript.map((t) => t.text));
  const picked = choosePooled(key, pool, null, said, null, render, rand);
  return { line: [picked.text, picked.tone], intent };
}

// Compose one spoken line the way the behavior spec asks for it: read the room,
// read the history, read what was just said to you, then choose a pool, a slice
// of that pool that suits this particular islander, and a sentence shape.
function speakRich(
  ctx: AgentContextView,
  partner: NearbyAgent | null,
  partnerName: string,
  transcript: TranscriptLine[],
  rand: () => number,
): Spoken {
  const voice = voiceOf(ctx);
  const rel = relationshipWith(ctx, partner);
  const last = partnerLastLine(transcript, ctx.self.name);
  const gossip = freshGossip(ctx, rand);
  const intent = readIntent(ctx, partner, rel, gossip);

  // A play can take over ordinary talk and campaigning, but never an endgame,
  // a hurt ally, or a conversation with somebody dangerous: those readings are
  // more urgent than anything the spec added.
  const play =
    intent === "small" || intent === "campaign" || intent === "warmth" || intent === "gossip"
      ? readPlay(ctx, partner, rand)
      : null;

  // Answering the previous line outranks ordinary talk but not an emergency. A
  // hostile line is ALWAYS answered as one, which is the acceptance criterion:
  // no light small talk on top of an accusation.
  const react =
    intent === "hostile" || intent === "allyHurt" ? null : readReaction(ctx, last);

  let thirdParty: string | null = null;
  let gossiped: OverheardFragment | null = null;
  let key: string;
  let pool: Line[];

  if (react && (!play || react === "rebuff" || react === "placate")) {
    key = `react:${react}`;
    pool = REACT_LINES[react];
  } else if (play) {
    key = `play:${play.intent}`;
    pool = playPool(play.intent);
    thirdParty = play.thirdParty;
  } else if (intent === "gossip" && gossip) {
    key = "intent:gossip";
    pool = intentPool("gossip");
    gossiped = gossip;
  } else if (intent !== "small") {
    key = `intent:${intent}`;
    pool = intentPool(intent);
  } else {
    // Ordinary talk. The class pools are still the default and still the
    // richest, they are simply no longer the only thing an islander can be
    // talking about, and a reply now stays on the subject the partner raised
    // rather than starting a fresh one every turn.
    const carried = carriedTopic(last);
    const topic = carried ?? chooseTopic(ctx, rand());
    if (topic === "smallTalk") {
      const opening = transcript.length === 0;
      key = opening ? `open:${ctx.self.klass}` : `reply:${ctx.self.klass}`;
      pool = opening
        ? [...OPENERS[ctx.self.klass], ...OPENERS_EXTRA[ctx.self.klass]]
        : [...REPLIES[ctx.self.klass], ...REPLIES_EXTRA[ctx.self.klass]];
    } else {
      key = `topic:${topic}`;
      pool = TOPIC_LINES[topic];
    }
  }

  const vars: Vars = {
    p: partnerName,
    s: ctx.self.name,
    t: thirdParty,
    g: gossiped?.speakerName ?? null,
    q: gossiped ? quotable(gossiped.text) : null,
    n: spokenCount(ctx.world?.livingCount),
  };
  const render = (raw: string) => fill(raw, vars).slice(0, 160);

  // Compared against the whole transcript, not just this speaker's lines, so
  // nobody parrots their partner either.
  const said = new Set(transcript.map((t) => t.text));
  const picked = choosePooled(key, pool, voice, said, ringFor(ctx.self.id), render, rand);
  remember(ctx.self.id, picked.id);
  if (gossiped) gossipSpoken.add(fragmentKey(ctx.self.id, gossiped));
  if (gossipSpoken.size > GOSSIP_SPOKEN_CAP) gossipSpoken.clear();

  return { line: [reshape(picked.text, voice, rand), picked.tone], intent };
}

function speak(
  ctx: AgentContextView,
  partnerName: string,
  transcript: TranscriptLine[],
  rand: () => number,
): Spoken {
  const partner = ctx.nearby.find((n) => n.name === partnerName) ?? null;
  return tunables.flags.conversationVariety
    ? speakRich(ctx, partner, partnerName, transcript, rand)
    : speakLegacy(ctx, partner, partnerName, transcript, rand);
}

// ---------------------------------------------------------------------------
// Outcomes.
// ---------------------------------------------------------------------------

// Whether there is anything for a truce to be a truce FROM.
//
// The legacy chooser offered truce unconditionally and first, in five of its
// seven branches, which is the mechanical reason 57% of conversations in a
// measured run ended in one. A truce is a de-escalation, so it needs an
// escalation behind it: either this exchange actually turned, or these two carry
// something unresolved into it. Without one of those, the honest answer is
// "nothing came of it".
function deEscalating(
  transcript: TranscriptLine[],
  rel: RelationshipSummary | null,
): boolean {
  if (transcript.some((l) => toneOf(l) === "hostile")) return true;
  return (rel?.recent ?? []).some((o) => o === "fight" || o === "tension");
}

// The pre-spec chooser, kept whole and reached when conversationVariety is off.
// Unchanged including its rand draws, so a flags-off run resolves exactly as it
// always did.
function chooseOutcomeLegacy(
  ctx: AgentContextView,
  partner: NearbyAgent | null,
  allowed: ConvOutcome["outcome"][],
  rand: () => number,
): ConvOutcome["outcome"] {
  const prefer = (list: ConvOutcome["outcome"][]): ConvOutcome["outcome"] | null =>
    list.find((o) => allowed.includes(o)) ?? null;

  const intent = readIntentLegacy(ctx, partner);
  let choice: ConvOutcome["outcome"] | null = null;

  switch (intent) {
    case "hostile":
      choice = prefer(["fight", "nothing"]);
      break;
    case "ally":
    case "allyHurt":
      choice = prefer(["alliance", "truce", "nothing"]);
      break;
    case "wary":
      // Only the classes with the stomach for it pick a fight with a killer.
      choice = prefer(
        ctx.self.klass === "bold" ? ["fight", "truce", "nothing"] : ["truce", "nothing"],
      );
      break;
    case "campaign":
      choice = prefer(["alliance", "truce", "nothing"]);
      break;
    case "vulnerable":
      choice = prefer(["truce", "alliance", "nothing"]);
      break;
    case "small":
      if (tunables.flags.earlyAggression && rand() < conflictChance(ctx)) {
        choice = prefer(["tension", "fight", "nothing"]);
      } else if (tunables.flags.conversationVariety && rand() < tunables.swarm.amicableChance) {
        choice = prefer(["amicable"]);
      }
      break;
    default:
      break;
  }
  if (choice) return choice;

  // No situational read: fall back to class temperament.
  switch (ctx.self.klass) {
    case "bold":
      choice = prefer(["fight", "nothing", "truce"]);
      break;
    case "timid":
      choice = prefer(["truce", "nothing"]);
      break;
    case "schemer":
      choice = prefer(["alliance", "truce", "nothing"]);
      break;
    case "charmer":
      choice = prefer(["alliance", "truce"]);
      break;
    case "wildcard":
      choice = allowed[Math.floor(rand() * allowed.length)] ?? null;
      break;
  }
  return choice ?? allowed[0] ?? "nothing";
}

// How this encounter ends.
//
// Two changes from the legacy chooser above, and between them they are the fix
// for "they almost exclusively go around making truces".
//
// First, a commit gate. The spec says at its outcome list that None is where
// most conversations end, so the question asked first is not "which outcome"
// but "was this worth an outcome at all". Ordinary talk clears that bar less
// than a third of the time; an endgame conversation almost always does.
//
// Second, "nothing" no longer sits at the back of every preference list behind
// truce. Truce is reachable only on an actual de-escalation read, and where it
// is not, an encounter that commits produces one of the spec's five outcomes
// instead.
function chooseOutcomeRich(
  ctx: AgentContextView,
  partner: NearbyAgent | null,
  transcript: TranscriptLine[],
  spokenIntent: Intent | null,
  allowed: ConvOutcome["outcome"][],
  rand: () => number,
): ConvOutcome["outcome"] {
  const prefer = (list: ConvOutcome["outcome"][]): ConvOutcome["outcome"] | null =>
    list.find((o) => allowed.includes(o)) ?? null;

  const rel = relationshipWith(ctx, partner);
  // Prefer the reading the closing line was actually spoken from. Re-reading is
  // only the fallback for a caller that has no line to go on, and it cannot see
  // a gossip intent at all because the fragment behind it is already consumed.
  const intent = spokenIntent ?? readIntent(ctx, partner, rel, null);

  // Temperament scales how readily an islander commits to anything at all, so a
  // timid one drifts out of conversations that a bold one turns into something.
  const temperament =
    ctx.self.klass === "timid" ? 0.7 : ctx.self.klass === "bold" ? 1.25 : 1;
  if (rand() >= COMMIT_CHANCE[intent] * temperament) return prefer(["nothing"]) ?? "nothing";

  const soothing = deEscalating(transcript, rel);
  const withTruce = (list: ConvOutcome["outcome"][], at = 0): ConvOutcome["outcome"][] =>
    soothing ? [...list.slice(0, at), "truce", ...list.slice(at)] : list;

  let choice: ConvOutcome["outcome"] | null = null;
  switch (intent) {
    case "hostile":
      choice = prefer(["fight", "tension", "nothing"]);
      break;
    case "grudge":
      // A grudge either finally boils over or hardens. Which one depends on who
      // is carrying it, not on the draw.
      choice = prefer(
        ctx.self.klass === "bold" || ctx.self.klass === "schemer"
          ? withTruce(["fight", "tension"], 2)
          : withTruce(["tension"]),
      );
      break;
    case "wary":
      choice = prefer(
        ctx.self.klass === "bold" ? withTruce(["fight", "tension"], 2) : withTruce(["tension"]),
      );
      break;
    case "ally":
    case "allyHurt":
    case "warmth":
      choice = prefer(withTruce(["alliance", "amicable"], 1));
      break;
    case "campaign":
      choice = prefer(withTruce(["alliance", "amicable"], 1));
      break;
    case "vulnerable":
      choice = prefer(withTruce(["amicable", "alliance"]));
      break;
    case "aftermath":
      // A shock brings people together more often than it splits them, but not
      // always, and never into a formal pact on the spot.
      choice = prefer(rand() < 0.75 ? ["amicable"] : ["tension"]);
      break;
    case "gossip":
      // Carrying a story either bonds the two of you or leaves a bad taste.
      choice = prefer(rand() < 0.5 ? ["amicable"] : ["tension"]);
      break;
    case "small":
      // Ordinary talk that committed. Conflict first when the aggression ramp
      // says so, warmth otherwise. Neither soft outcome carries a mechanical
      // consequence server side, so this only ever adds relationship signal: a
      // villa that remembers a warm afternoon and one that remembers a sour one.
      choice =
        tunables.flags.earlyAggression && rand() < conflictChance(ctx)
          ? prefer(["tension", "fight"])
          : // Most warmth between two people who barely know each other is
            // warmth, not a pact. A minority of it is how a bloc starts, which
            // is the only way an alliance forms out of ordinary talk.
            prefer(rand() < 0.3 ? ["alliance", "amicable"] : ["amicable", "alliance"]);
      break;
  }
  if (choice) return choice;

  // Nothing situational was available in the allowed set. Fall back to class
  // temperament, with "nothing" reachable from every branch rather than sitting
  // behind truce in five of seven.
  switch (ctx.self.klass) {
    case "bold":
      choice = prefer(["fight", "tension", "nothing"]);
      break;
    case "timid":
      choice = prefer(["amicable", "nothing"]);
      break;
    case "schemer":
      choice = prefer(["alliance", "tension", "nothing"]);
      break;
    case "charmer":
      choice = prefer(["amicable", "alliance", "nothing"]);
      break;
    case "wildcard":
      choice = allowed[Math.floor(rand() * allowed.length)] ?? null;
      break;
  }
  // The legacy last resort was `allowed[0]`, which is "nothing" by construction
  // at every call site, so every unresolved case collapsed to the same answer
  // whatever the situation had been. Prefer a soft outcome that is actually in
  // the allowed set before giving up on the encounter entirely.
  return choice ?? prefer(["amicable", "tension", "nothing"]) ?? "nothing";
}

function chooseOutcome(
  ctx: AgentContextView,
  partnerName: string,
  transcript: TranscriptLine[],
  spokenIntent: Intent | null,
  allowed: ConvOutcome["outcome"][],
  rand: () => number,
): ConvOutcome["outcome"] {
  const partner = ctx.nearby.find((n) => n.name === partnerName) ?? null;
  // The legacy chooser deliberately does NOT take the spoken intent: it draws
  // from `rand` in a fixed order that a flags-off replay depends on, and it
  // re-reads the context exactly as it always did.
  return tunables.flags.conversationVariety
    ? chooseOutcomeRich(ctx, partner, transcript, spokenIntent, allowed, rand)
    : chooseOutcomeLegacy(ctx, partner, allowed, rand);
}

const result = <T>(value: T): LLMResult<T> => ({
  value,
  usage: ZERO_USAGE,
  latencyMs: 0,
  cached: false,
  backend: "rules",
  fallback: true,
});

// The line that closes an encounter which ended in a truce. Chosen after the
// outcome rather than before it, which is why the word no longer appears in the
// class reply pools: speech follows the outcome instead of advertising it.
function truceLine(ctx: AgentContextView, partnerName: string, rand: () => number): Line {
  const voice = tunables.flags.conversationVariety ? voiceOf(ctx) : null;
  const render = (raw: string) =>
    fill(raw, { p: partnerName, s: ctx.self.name }).slice(0, 160);
  const picked = choosePooled(
    "truce",
    TRUCE_LINES,
    voice,
    new Set<string>(),
    voice ? ringFor(ctx.self.id) : null,
    render,
    rand,
  );
  if (voice) remember(ctx.self.id, picked.id);
  return [picked.text, picked.tone];
}

export function createRuleBackend(): ModelBackend {
  return {
    name: "rules",
    // Free by construction, so a rules-only game never touches the spend cap.
    billable: false,
    async healthy() {
      return true; // the whole point: it cannot be unreachable
    },
    async decide(ctx, rand) {
      return result(fallbackDecision(ctx, rand));
    },
    async converse(ctx, partnerName, transcript, rand) {
      const [text, tone] = speak(ctx, partnerName, transcript, rand).line;
      return result({ text, tone, wantsToEnd: false });
    },
    async resolve(ctx, partnerName, transcript, allowedOutcomes, rand) {
      const spoken = speak(ctx, partnerName, transcript, rand);
      const [text, tone] = spoken.line;
      const outcome = chooseOutcome(
        ctx,
        partnerName,
        transcript,
        tunables.flags.conversationVariety ? spoken.intent : null,
        allowedOutcomes,
        rand,
      );
      // A truce now has its own closing line, so the one place the word belongs
      // is the one turn that actually produced one.
      if (outcome === "truce" && tunables.flags.conversationVariety) {
        const [truceText, truceTone] = truceLine(ctx, partnerName, rand);
        return result({ text: truceText, tone: truceTone, outcome });
      }
      return result({ text, tone, outcome });
    },
  };
}
