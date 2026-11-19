// The curated reading list rendered at /literature. Deliberately short: the
// works a newcomer needs to understand the rank records, how small high-rank
// curves are found, and how ranks are bounded. Every entry's metadata was
// checked against the publisher, DOI, or arXiv record; keep it that way when
// adding entries. Ids are stable URL anchors (/literature#<id>), so don't
// rename them once deployed.

export interface BibEntry {
  id: string
  authors: string
  title: string
  // Journal/proceedings/publisher. May include the year, as in
  // "Math. Comp. 88 (2019), 837–846"; the page then doesn't repeat it.
  venue?: string
  // Omitted for continuously updated web resources.
  year?: number
  doi?: string
  arxiv?: string
  // An open copy or the canonical home when there is no DOI (mailing-list
  // archive, author's PDF, project page).
  url?: string
  // Why it matters here, one sentence.
  note: string
}

export interface BibSection {
  id: string
  title: string
  entries: BibEntry[]
}

const zb = (an: string) => `https://zbmath.org/?q=an:${an}`
const NMBRTHRY = 'https://listserv.nodak.edu/cgi-bin/wa.exe?A2=NMBRTHRY;'

export const LITERATURE: BibSection[] = [
  {
    id: 'records',
    title: 'Rank records',
    entries: [
      {
        id: 'dujella-rankhist',
        authors: 'Andrej Dujella',
        title: 'History of elliptic curves rank records',
        url: 'https://web.math.pmf.unizg.hr/~duje/tors/rankhist.html',
        note: 'The standard record table, from Billing (rank 3, 1938) to the present, with the year each record was set and who set it.',
      },
      {
        id: 'mestre-1982',
        authors: 'Jean-François Mestre',
        title: 'Construction d’une courbe elliptique de rang ≥ 12',
        venue: 'C. R. Acad. Sci. Paris Sér. I Math. 295 (1982), 643–644',
        year: 1982,
        url: zb('0541.14027'),
        note: 'Mestre’s construction of a curve of rank ≥ 12 from a degree-12 polynomial written as a square plus a small remainder, the basis of many later records.',
      },
      {
        id: 'nagao-kouya-1994',
        authors: 'Koh-ichi Nagao and Tomonori Kouya',
        title: 'An example of elliptic curve over Q with rank ≥ 21',
        venue: 'Proc. Japan Acad. Ser. A Math. Sci. 70 (1994), no. 4, 104–105',
        year: 1994,
        doi: '10.3792/pjaa.70.104',
        note: 'Record rank ≥ 21.',
      },
      {
        id: 'martin-mcmillen-2000',
        authors: 'Roland Martin and William McMillen',
        title: 'An elliptic curve over Q with rank at least 24',
        venue: 'Number Theory Listserver (posted by Victor S. Miller), 2 May 2000',
        year: 2000,
        url: `${NMBRTHRY}b8b5e7f2.0005&S=`,
        note: 'Record rank ≥ 24, which stood until 2006.',
      },
      {
        id: 'elkies-2006',
        authors: 'Noam D. Elkies',
        title: 'Z^28 in E(Q), etc.',
        venue: 'Number Theory Listserver, 3 May 2006',
        year: 2006,
        url: `${NMBRTHRY}99f4e7cd.0605&S=`,
        note: 'The rank ≥ 28 curve, a fibre of an elliptic K3 surface of Mordell–Weil rank 17 over Q(t). It held the record for 18 years.',
      },
      {
        id: 'klagsbrun-sherman-weigandt-2019',
        authors: 'Zev Klagsbrun, Travis Sherman, and James Weigandt',
        title: 'The Elkies curve has rank 28 subject only to GRH',
        venue: 'Math. Comp. 88 (2019), no. 316, 837–846',
        year: 2019,
        doi: '10.1090/mcom/3348',
        arxiv: '1606.07178',
        note: 'A matching upper bound, via class-group computations that assume GRH: the 2006 curve has rank exactly 28.',
      },
      {
        id: 'elkies-klagsbrun-2024',
        authors: 'Noam D. Elkies and Zev Klagsbrun',
        title: 'Z^29 in E(Q)',
        venue: 'Number Theory Listserver, 2024',
        year: 2024,
        url: `${NMBRTHRY}b9d018b1.2409&FT=&P=&H=&S=b`,
        note: 'Record rank ≥ 29, the first improvement on the 2006 record.',
      },
      {
        id: 'elkies-2026',
        authors: 'Noam D. Elkies',
        title: 'An elliptic K3 surface X/Q(t) with Mordell–Weil rank 17, I: Formulas for X and base changes of rank 18 and 19',
        year: 2026,
        arxiv: '2608.25406',
        note: 'Explicit formulas for the rank-17 surface behind the 2006 record.',
      },
    ],
  },
  {
    id: 'constructions',
    title: 'Constructing curves of high rank',
    entries: [
      {
        id: 'nagao-1994',
        authors: 'Koh-ichi Nagao',
        title: 'Construction of high-rank elliptic curves',
        venue: 'Kobe J. Math. 11 (1994), no. 2, 211–219',
        year: 1994,
        url: zb('0848.11026'),
        note: 'Source of the Mestre–Nagao sums: averages of a_p over small primes, used to sieve families for curves likely to have high rank before any points are searched for.',
      },
      {
        id: 'elkies-2007',
        authors: 'Noam D. Elkies',
        title: 'Three lectures on elliptic surfaces and curves of high rank',
        venue: 'Oberwolfach workshop “Explicit Methods in Number Theory”',
        year: 2007,
        arxiv: '0709.2908',
        note: 'An overview of the elliptic-surface method behind the modern records: find a surface of high rank over Q(t), then search its fibres.',
      },
      {
        id: 'elkies-watkins-2004',
        authors: 'Noam D. Elkies and Mark Watkins',
        title: 'Elliptic curves of large rank and small conductor',
        venue: 'Algorithmic Number Theory (ANTS-VI), LNCS 3076, Springer (2004), 42–56',
        year: 2004,
        doi: '10.1007/978-3-540-24847-7_3',
        arxiv: 'math/0403374',
        note: 'The direct predecessor of this leaderboard: searches for curves of each rank with the smallest possible conductor and discriminant.',
      },
      {
        id: 'elkies-rogers-2004',
        authors: 'Noam D. Elkies and Nicholas F. Rogers',
        title: 'Elliptic curves x³ + y³ = k of high rank',
        venue: 'Algorithmic Number Theory (ANTS-VI), LNCS 3076, Springer (2004), 184–193',
        year: 2004,
        doi: '10.1007/978-3-540-24847-7_13',
        arxiv: 'math/0403116',
        note: 'Rank records for the cube-sum curves, one of the subfamilies tracked here.',
      },
      {
        id: 'elkies-klagsbrun-2020',
        authors: 'Noam D. Elkies and Zev Klagsbrun',
        title: 'New rank records for elliptic curves having rational torsion',
        venue: 'ANTS XIV, Open Book Series 4, MSP (2020), 233–250',
        year: 2020,
        doi: '10.2140/obs.2020.4.233',
        arxiv: '2003.00077',
        note: 'Records for several torsion groups. Its rank-9 family with Z/2Z torsion is the source of many curves on this site.',
      },
      {
        id: 'watkins-et-al-2014',
        authors: 'Mark Watkins, Stephen Donnelly, Noam D. Elkies, Tom Fisher, Andrew Granville, and Nicholas F. Rogers',
        title: 'Ranks of quadratic twists of elliptic curves',
        venue: 'Publ. Math. Besançon Algèbre Théorie Nr. 2014/2, 63–98',
        year: 2014,
        doi: '10.5802/pmb.9',
        note: 'Large searches over quadratic twists, including congruent-number curves of rank 7.',
      },
    ],
  },
  {
    id: 'boundedness',
    title: 'Are ranks bounded?',
    entries: [
      {
        id: 'ppvw-2019',
        authors: 'Jennifer Park, Bjorn Poonen, John Voight, and Melanie Matchett Wood',
        title: 'A heuristic for boundedness of ranks of elliptic curves',
        venue: 'J. Eur. Math. Soc. 21 (2019), no. 9, 2859–2903',
        year: 2019,
        doi: '10.4171/jems/893',
        arxiv: '1602.01431',
        note: 'A random-matrix model of Selmer and Shafarevich–Tate groups which predicts that only finitely many curves over Q have rank above 21.',
      },
      {
        id: 'watkins-2008',
        authors: 'Mark Watkins',
        title: 'Some heuristics about elliptic curves',
        venue: 'Experiment. Math. 17 (2008), no. 1, 105–125',
        year: 2008,
        doi: '10.1080/10586458.2008.10129019',
        arxiv: 'math/0608766',
        note: 'Heuristics, tested against data, for the distribution of ranks and related invariants of elliptic curves.',
      },
      {
        id: 'bhkssw-2016',
        authors: 'Jennifer S. Balakrishnan, Wei Ho, Nathan Kaplan, Simon Spicer, William Stein, and James Weigandt',
        title: 'Databases of elliptic curves ordered by height and distributions of Selmer groups and ranks',
        venue: 'LMS J. Comput. Math. 19 (2016), issue A, 351–370',
        year: 2016,
        doi: '10.1112/S1461157016000152',
        arxiv: '1602.01894',
        note: 'A database of all curves up to a height bound, used to test predictions for the distributions of Selmer groups and ranks.',
      },
    ],
  },
  {
    id: 'methods',
    title: 'Proving rank bounds',
    entries: [
      {
        id: 'cremona-2002',
        authors: 'J. E. Cremona',
        title: 'On the computation of Mordell–Weil and 2-Selmer groups of elliptic curves',
        venue: 'Rocky Mountain J. Math. 32 (2002), no. 3, 953–967',
        year: 2002,
        doi: '10.1216/rmjm/1034968425',
        url: 'https://johncremona.github.io/papers/filter.pdf',
        note: 'Section 2 is the quadratic-character test (due to Brumer) that this site uses to prove that submitted points are independent.',
      },
      {
        id: 'simon-2002',
        authors: 'Denis Simon',
        title: 'Computing the rank of elliptic curves over number fields',
        venue: 'LMS J. Comput. Math. 5 (2002), 7–17',
        year: 2002,
        doi: '10.1112/S1461157000000668',
        note: 'The 2-descent algorithm behind PARI/GP’s ellrank, which gives the upper bounds and exact ranks recorded here.',
      },
      {
        id: 'mestre-1986',
        authors: 'Jean-François Mestre',
        title: 'Formules explicites et minorations de conducteurs de variétés algébriques',
        venue: 'Compositio Math. 58 (1986), no. 2, 209–232',
        year: 1986,
        url: 'http://www.numdam.org/item/CM_1986__58_2_209_0/',
        note: 'The explicit formula giving upper bounds on analytic rank under GRH, used in the conditional upper bounds for the record curves.',
      },
      {
        id: 'bober-2013',
        authors: 'Jonathan W. Bober',
        title: 'Conditionally bounding analytic ranks of elliptic curves',
        venue: 'ANTS X, Open Book Series 1, MSP (2013), 135–144',
        year: 2013,
        doi: '10.2140/obs.2013.1.135',
        arxiv: '1112.1503',
        note: 'A practical version of the explicit-formula bound, used for GRH-conditional upper bounds on the analytic ranks of some record curves here.',
      },
    ],
  },
  {
    id: 'textbooks',
    title: 'Textbooks',
    entries: [
      {
        id: 'silverman-aec',
        authors: 'Joseph H. Silverman',
        title: 'The Arithmetic of Elliptic Curves',
        venue: '2nd ed., Graduate Texts in Mathematics 106, Springer',
        year: 2009,
        doi: '10.1007/978-0-387-09494-6',
        note: 'The standard graduate text, covering the Mordell–Weil theorem, heights, and descent.',
      },
      {
        id: 'cremona-algorithms',
        authors: 'J. E. Cremona',
        title: 'Algorithms for Modular Elliptic Curves',
        venue: '2nd ed., Cambridge University Press',
        year: 1997,
        url: 'https://johncremona.github.io/book/fulltext/index.html',
        note: 'Algorithms for minimal models, torsion, heights, and 2-descent. Free online with the publisher’s permission.',
      },
    ],
  },
  {
    id: 'data',
    title: 'Tables and databases',
    entries: [
      {
        id: 'dujella-torsion',
        authors: 'Andrej Dujella',
        title: 'High rank elliptic curves with prescribed torsion',
        url: 'https://web.math.pmf.unizg.hr/~duje/tors/tors.html',
        note: 'Record ranks for each of the 15 possible torsion groups over Q, with curves and references.',
      },
      {
        id: 'lmfdb',
        authors: 'The LMFDB Collaboration',
        title: 'The L-functions and Modular Forms Database: elliptic curves over Q',
        url: 'https://www.lmfdb.org/EllipticCurve/Q/',
        note: 'Ranks, generators, and L-function data for millions of curves, including every curve of small conductor.',
      },
      {
        id: 'cremona-ecdata',
        authors: 'J. E. Cremona',
        title: 'Elliptic curve data',
        url: 'https://johncremona.github.io/ecdata/',
        note: 'The Cremona database of all curves of bounded conductor, with Mordell–Weil generators.',
      },
      {
        id: 'stein-watkins-2002',
        authors: 'William A. Stein and Mark Watkins',
        title: 'A database of elliptic curves — first report',
        venue: 'Algorithmic Number Theory (ANTS-V), LNCS 2369, Springer (2002), 267–275',
        year: 2002,
        doi: '10.1007/3-540-45455-1_22',
        note: 'A database of millions of curves of conductor up to 10^8.',
      },
      {
        id: 'rubinstein-tables',
        authors: 'M. Rubinstein',
        title: 'Tables of elliptic curves over Q, organised by rank',
        year: 2026,
        url: 'https://github.com/mrubinst/elliptic-curves-by-rank',
        note: 'About 19 million curves of proven rank 4–15, sorted by several height measures. The most-cited source in this site’s commentary.',
      },
    ],
  },
]
