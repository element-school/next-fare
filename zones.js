// Zones the engine knows about. Centroids are approximate; radius (km) is how far a
// location can be from the centroid and still count as "in" the zone.
// type drives the demand curve in engine.js; seattle marks city limits (higher pay floor).
(function (root) {
  const ZONES = [
    // ---- Seattle (higher pay floor) ----
    { id: 'downtown',   name: 'Downtown · Pike Place',        lat: 47.6097, lng: -122.3410, r: 0.9, type: 'downtown',  seattle: true,  tip: 'Hotels on 1st–4th Ave; Pike Place and the waterfront for tourists.' },
    { id: 'belltown',   name: 'Belltown',                     lat: 47.6150, lng: -122.3480, r: 0.7, type: 'nightlife', seattle: true,  tip: '2nd Ave between Bell and Blanchard has the bar cluster.' },
    { id: 'slu',        name: 'South Lake Union',             lat: 47.6262, lng: -122.3370, r: 0.9, type: 'office',    seattle: true,  tip: 'Amazon and office towers; Westlake Ave for commuters.' },
    { id: 'caphill',    name: 'Capitol Hill (Pike/Pine)',     lat: 47.6145, lng: -122.3200, r: 0.8, type: 'nightlife', seattle: true,  tip: 'Pike/Pine between Broadway and 12th; stay a block off the main strip.' },
    { id: 'firsthill',  name: 'First Hill hospitals',         lat: 47.6090, lng: -122.3240, r: 0.6, type: 'medical',   seattle: true,  tip: 'Swedish, Harborview and Virginia Mason; shift changes and discharges.' },
    { id: 'pioneer',    name: 'Pioneer Square',               lat: 47.6008, lng: -122.3330, r: 0.6, type: 'nightlife', seattle: true,  tip: 'Occidental and 1st Ave S bars; ferry terminal walk-offs.' },
    { id: 'sodo',       name: 'SoDo · Stadiums',              lat: 47.5920, lng: -122.3320, r: 0.9, type: 'stadium',   seattle: true,  tip: 'Only worth it around games, and then from the edges.' },
    { id: 'center',     name: 'Seattle Center · Lower Queen Anne', lat: 47.6235, lng: -122.3540, r: 0.8, type: 'center', seattle: true, tip: 'Queen Anne Ave N bars and restaurants; Climate Pledge Arena.' },
    { id: 'queenanne',  name: 'Queen Anne (upper)',           lat: 47.6370, lng: -122.3570, r: 1.0, type: 'residential', seattle: true, tip: 'Residential; early-morning airport runs.' },
    { id: 'fremont',    name: 'Fremont',                      lat: 47.6510, lng: -122.3500, r: 0.7, type: 'nightlife', seattle: true,  tip: 'N 35th–36th St bars; close to Wallingford and Ballard drop-offs.' },
    { id: 'ballard',    name: 'Ballard Ave',                  lat: 47.6680, lng: -122.3850, r: 0.9, type: 'nightlife', seattle: true,  tip: 'Ballard Ave NW and Market St.' },
    { id: 'wallingford',name: 'Wallingford',                  lat: 47.6610, lng: -122.3340, r: 0.9, type: 'residential', seattle: true, tip: 'Residential; N 45th St restaurants.' },
    { id: 'udistrict',  name: 'U District',                   lat: 47.6610, lng: -122.3130, r: 0.9, type: 'campus',    seattle: true,  tip: 'The Ave and campus edges; short trips, steady volume.' },
    { id: 'greenlake',  name: 'Green Lake',                   lat: 47.6800, lng: -122.3260, r: 1.0, type: 'residential', seattle: true, tip: 'Residential; early-morning airport runs.' },
    { id: 'ravenna',    name: 'Ravenna · Wedgwood',           lat: 47.6830, lng: -122.3000, r: 1.2, type: 'residential', seattle: true, tip: 'Residential; early-morning airport runs.' },
    { id: 'northgate',  name: 'Northgate',                    lat: 47.7060, lng: -122.3260, r: 1.3, type: 'residential', seattle: true, tip: 'Light rail station and mall.' },
    { id: 'magnolia',   name: 'Magnolia',                     lat: 47.6480, lng: -122.4000, r: 1.4, type: 'residential', seattle: true, tip: 'Residential, few drivers; early-morning airport runs.' },
    { id: 'madison',    name: 'Madison Park · Leschi',        lat: 47.6250, lng: -122.2900, r: 1.3, type: 'residential', seattle: true, tip: 'Affluent residential; airport runs.' },
    { id: 'westseattle',name: 'West Seattle Junction',        lat: 47.5610, lng: -122.3870, r: 1.6, type: 'residential', seattle: true, tip: 'California Ave SW; long bridge commute out.' },
    { id: 'columbia',   name: 'Columbia City · Beacon Hill',  lat: 47.5600, lng: -122.2920, r: 1.5, type: 'residential', seattle: true, tip: 'Residential; light rail.' },
    { id: 'georgetown', name: 'Georgetown',                   lat: 47.5480, lng: -122.3220, r: 1.0, type: 'mixed',     seattle: true,  tip: 'Closest Seattle-rate area to SEA: wait here after an airport drop-off.' },
    // ---- Outside Seattle (state pay floor) ----
    { id: 'sea',        name: 'SEA airport',                  lat: 47.4502, lng: -122.3088, r: 1.6, type: 'airport',   seattle: false, tip: 'Check your place in the waiting-lot line in the driver app.' },
    { id: 'tukwila',    name: 'Tukwila · Southcenter',        lat: 47.4590, lng: -122.2580, r: 1.5, type: 'mixed',     seattle: false, tip: 'Mall and airport hotels.' },
    { id: 'renton',     name: 'Renton',                       lat: 47.4830, lng: -122.2170, r: 2.0, type: 'residential', seattle: false, tip: 'Residential; Boeing plant shifts.' },
    { id: 'kirkland',   name: 'Downtown Kirkland',            lat: 47.6769, lng: -122.2060, r: 0.9, type: 'nightlife', seattle: false, tip: 'Park Lane and Lake St restaurants and bars.' },
    { id: 'totemlake',  name: 'Kirkland · Totem Lake',        lat: 47.7100, lng: -122.1850, r: 2.0, type: 'residential', seattle: false, tip: 'Residential Eastside; early-morning airport runs.' },
    { id: 'bellevue',   name: 'Downtown Bellevue',            lat: 47.6150, lng: -122.2010, r: 1.2, type: 'downtown',  seattle: false, tip: 'Hotels, offices and Bellevue Square; Main St restaurants at night.' },
    { id: 'redmond',    name: 'Redmond (Microsoft · Downtown)', lat: 47.6550, lng: -122.1300, r: 2.2, type: 'office', seattle: false, tip: 'Microsoft campus commutes; Redmond Town Center.' },
    { id: 'bothell',    name: 'Bothell · Woodinville',        lat: 47.7600, lng: -122.2050, r: 2.5, type: 'residential', seattle: false, tip: 'Residential; good spot to be if a PAE flight is landing.' },
    { id: 'lynnwood',   name: 'Lynnwood · Alderwood',         lat: 47.8200, lng: -122.2950, r: 2.5, type: 'residential', seattle: false, tip: 'Residential and mall; light rail.' },
    { id: 'pae',        name: 'Paine Field (PAE)',            lat: 47.9063, lng: -122.2816, r: 1.5, type: 'smallairport', seattle: false, tip: 'Alaska only. Worth it only when a flight is landing soon.' }
  ];
  const api = { ZONES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.NF_ZONES = api;
})(typeof window !== 'undefined' ? window : globalThis);
