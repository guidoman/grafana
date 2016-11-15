define([
  './query_def',
  'app/core/config',
  'js_timezone_detect'
],
function (queryDef, config, jstz) {
  'use strict';

  function ElasticQueryBuilder(options) {
    this.timeField = options.timeField;
    this.esVersion = options.esVersion;
  }

  ElasticQueryBuilder.prototype.getRangeFilter = function() {
    var filter = {};
    filter[this.timeField] = {"gte": "$timeFrom", "lte": "$timeTo"};

    if (this.esVersion >= 2) {
      filter[this.timeField]["format"] = "epoch_millis";
    }

    return filter;
  };

  ElasticQueryBuilder.prototype.buildTermsAgg = function(aggDef, queryNode, target) {
    var metricRef, metric, y;
    if (aggDef.settings.field_type === 'Expression') {
      queryNode.terms = { "script": aggDef.field };
    } else if (aggDef.settings.field_type === 'Groovy') {
      queryNode.terms = { "script": aggDef.field };
    } else {
      queryNode.terms = { "field": aggDef.field };
    }

    if (!aggDef.settings) {
      return queryNode;
    }

    queryNode.terms.size = parseInt(aggDef.settings.size, 10);
    if (aggDef.settings.orderBy !== void 0) {
      queryNode.terms.order = {};
      queryNode.terms.order[aggDef.settings.orderBy] = aggDef.settings.order;

      // if metric ref, look it up and add it to this agg level
      metricRef = parseInt(aggDef.settings.orderBy, 10);
      if (!isNaN(metricRef)) {
        for (y = 0; y < target.metrics.length; y++) {
          metric = target.metrics[y];
          if (metric.id === aggDef.settings.orderBy) {
            queryNode.aggs = {};
            queryNode.aggs[metric.id] = {};
            queryNode.aggs[metric.id][metric.type] = {field: metric.field};
            break;
          }
        }
      }
    }

    return queryNode;
  };

  ElasticQueryBuilder.prototype.getDateHistogramAgg = function(aggDef) {
    var esAgg = {};
    var settings = aggDef.settings || {};
    esAgg.interval = settings.interval;
    esAgg.field = this.timeField;
    esAgg.min_doc_count = settings.min_doc_count || 0;

    if (config.bootData.user.timezone === 'browser') {
      esAgg.format = 'strict_date_time_no_millis';
      esAgg.time_zone = jstz.determine().name();
    }
    else {
      esAgg.extended_bounds = {min: "$timeFrom", max: "$timeTo"};
    }

    if (esAgg.interval === 'auto') {
      esAgg.interval = "$interval";
    }

    if (this.esVersion >= 2) {
      esAgg.format = "epoch_millis";
    }

    return esAgg;
  };

  ElasticQueryBuilder.prototype.getHistogramAgg = function(aggDef) {
    var esAgg = {};
    var settings = aggDef.settings || {};
    esAgg.interval = settings.histogram_interval || 1;
    if (settings.field_type === 'Expression') {
      //Script with inline expression
      esAgg.script = aggDef.field;
      esAgg.lang = 'expression';//settings.histogram_field_type;
    } else if (settings.field_type === 'Groovy') {
      //Script with inline expression
      esAgg.script = aggDef.field;
      esAgg.lang = 'groovy';//settings.histogram_field_type;
    } else {
      esAgg.field = aggDef.field;
    }
    esAgg.min_doc_count = settings.min_doc_count || 0;
    //esAgg.extended_bounds = {min: "$minFrom", max: "$maxTo"};

    return esAgg;
  };

  ElasticQueryBuilder.prototype.getFiltersAgg = function(aggDef) {
    var filterObj = {};

    for (var i = 0; i < aggDef.settings.filters.length; i++) {
      var query = aggDef.settings.filters[i].query;
      filterObj[query] = {
        query: {
          query_string: {
            query: query,
            analyze_wildcard: true
          }
        }
      };
    }

    return filterObj;
  };

  ElasticQueryBuilder.prototype.documentQuery = function(query) {
    query.size = 500;
    query.sort = {};
    query.sort[this.timeField] = {order: 'desc', unmapped_type: 'boolean'};
    query.fields = ["*", "_source"];
    query.script_fields = {},
    query.fielddata_fields = [this.timeField];
    return query;
  };

  ElasticQueryBuilder.prototype.addAdhocFilters = function(query, adhocFilters) {
    if (!adhocFilters) {
      return;
    }

    var i, filter, condition;
    var must = query.query.filtered.filter.bool.must;

    for (i = 0; i < adhocFilters.length; i++) {
      filter = adhocFilters[i];
      condition = {};
      condition[filter.key] = filter.value;
      must.push({"term": condition});
    }
  };

  ElasticQueryBuilder.prototype.build = function(target, adhocFilters) {
    // make sure query has defaults;
    target.metrics = target.metrics || [{ type: 'count', id: '1' }];
    target.dsType = 'elasticsearch';
    target.bucketAggs = target.bucketAggs || [{type: 'date_histogram', id: '2', settings: {interval: 'auto'}}];
    target.timeField =  this.timeField;

    var i, nestedAggs, metric;
    var query = {
      "size": 0,
      "query": {
        "filtered": {
          "query": {
            "query_string": {
              "analyze_wildcard": true,
              "query": '$lucene_query',
            }
          },
          "filter": {
            "bool": {
              "must": [{"range": this.getRangeFilter()}]
            }
          }
        }
      }
    };

    this.addAdhocFilters(query, adhocFilters);

    // handle document query
    if (target.bucketAggs.length === 0) {
      metric = target.metrics[0];
      if (metric && metric.type !== 'raw_document') {
        throw {message: 'Invalid query'};
      }
      return this.documentQuery(query, target);
    }

    nestedAggs = query;

    for (i = 0; i < target.bucketAggs.length; i++) {
      var aggDef = target.bucketAggs[i];
      var esAgg = {};

      switch (aggDef.type) {
        case 'date_histogram': {
          esAgg["date_histogram"] = this.getDateHistogramAgg(aggDef);
          break;
        }
        case 'histogram': {
          esAgg["histogram"] = this.getHistogramAgg(aggDef);
          break;
        }
        case 'filters': {
          esAgg["filters"] = {filters: this.getFiltersAgg(aggDef)};
          break;
        }
        case 'terms':
        case 'terms_histogram': {
          this.buildTermsAgg(aggDef, esAgg, target);
          break;
        }
        case 'geohash_grid': {
          esAgg['geohash_grid'] = {field: aggDef.field, precision: aggDef.settings.precision};
          break;
        }
      }

      nestedAggs.aggs = nestedAggs.aggs || {};
      nestedAggs.aggs[aggDef.id] = esAgg;
      nestedAggs = esAgg;
    }

    nestedAggs.aggs = {};

    for (i = 0; i < target.metrics.length; i++) {
      metric = target.metrics[i];
      if (metric.type === 'count') {
        continue;
      }

      var aggField = {};
      var metricAgg = null;

      if (queryDef.isPipelineAgg(metric.type)) {
        if (metric.pipelineAgg && /^\d*$/.test(metric.pipelineAgg)) {
          metricAgg = { buckets_path: metric.pipelineAgg };
        } else {
          continue;
        }
      } else if (queryDef.isComplexPipelineAgg(metric.type)) {
        if (metric.values && /^\d*$/.test(metric.values) &&
            metric.weights && /^\d*$/.test(metric.weights)) {
          metricAgg = { buckets_path: { "_1": metric.values, "_2": metric.weights } };
        } else {
          continue;
        }
      } else {
        metricAgg = {field: metric.field};
      }

      for (var prop in metric.settings) {
        if (metric.settings.hasOwnProperty(prop) && metric.settings[prop] !== null) {
          metricAgg[prop] = metric.settings[prop];
        }
      }

      aggField[metric.type] = metricAgg;
      nestedAggs.aggs[metric.id] = aggField;
    }

    return query;
  };

  ElasticQueryBuilder.prototype.getTermsQuery = function(queryDef) {
    var query = {
      "size": 0,
      "query": {
        "filtered": {
          "filter": {
            "bool": {
              "must": [{"range": this.getRangeFilter()}]
            }
          }
        }
      }
    };

    if (queryDef.query) {
      query.query.filtered.query = {
        "query_string": {
          "analyze_wildcard": true,
          "query": queryDef.query,
        }
      };
    }

    query.aggs =  {
      "1": {
        "terms": {
          "field": queryDef.field,
          "size": 0,
          "order": {
            "_term": "asc"
          }
        },
      }
    };

    return query;
  };

  return ElasticQueryBuilder;
});
